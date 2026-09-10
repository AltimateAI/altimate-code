// altimate_change start — regression guard for the ACP default-model preference. The v1.17.9 merge
// rewrote defaultModelFromConfig and dropped the fork's "prefer altimate-backend/altimate-default"
// behavior, routing ACP clients (Zed/editors) to the opencode provider instead of altimate's backend.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import { ProviderSchema } from "@/provider/schema"
import { ACPService } from "@/acp/service"
import { Directory } from "@/acp/directory"

const model = (providerID: ProviderSchema.ProviderID, id: string): Provider.Model => ({
  id: ProviderSchema.ModelID.make(id),
  providerID,
  api: { id, url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
  name: id,
  family: "test",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

const provider = (id: string, modelIDs: string[]): Provider.Info => {
  const providerID = ProviderSchema.ProviderID.make(id)
  return {
    id: providerID,
    name: id,
    source: "config",
    env: [],
    options: {},
    models: Object.fromEntries(modelIDs.map((m) => [ProviderSchema.ModelID.make(m), model(providerID, m)])),
  } as Provider.Info
}

const providers = (...infos: Provider.Info[]) =>
  Object.fromEntries(infos.map((p) => [p.id, p])) as Record<ProviderV2.ID, Provider.Info>

describe("ACP defaultModelFromConfig", () => {
  test("prefers altimate-backend/altimate-default when available and no model configured", () => {
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("altimate-backend", ["altimate-default"]), provider("opencode", ["big-pickle"])),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("altimate-backend"),
      modelID: ModelV2.ID.make("altimate-default"),
    })
  })

  test("prefers registered Altimate Base when the paid gateway is not present", () => {
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("altimate-free", ["altimate-base"]), provider("opencode", ["big-pickle"])),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("altimate-free"),
      modelID: ModelV2.ID.make("altimate-base"),
    })
  })

  test("treats an empty provider object as unrestricted", () => {
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("altimate-free", ["altimate-base"]), provider("opencode", ["big-pickle"])),
      {},
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("altimate-free"),
      modelID: ModelV2.ID.make("altimate-base"),
    })
  })

  test("registered Altimate Base outranks public Zen in both implicit scans", () => {
    const zen = provider("opencode", ["big-pickle", "nemotron-3-super-free"])
    zen.options.apiKey = "public"
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(zen, provider("altimate-free", ["altimate-base"])),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("altimate-free"),
      modelID: ModelV2.ID.make("altimate-base"),
    })
  })

  test.each([
    {
      name: "public Zen recent outranks registered Base",
      recent: ["opencode/nemotron-3-super-free"],
      expected: "opencode/nemotron-3-super-free",
    },
    { name: "unloaded provider recent is ignored", recent: ["missing/model"], expected: "altimate-free/altimate-base" },
    { name: "missing model recent is ignored", recent: ["opencode/missing"], expected: "altimate-free/altimate-base" },
    {
      name: "first available recent wins",
      recent: ["missing/model", "opencode/missing", "opencode/nemotron-3-super-free", "altimate-free/altimate-base"],
      expected: "opencode/nemotron-3-super-free",
    },
    {
      name: "Base recent is skipped with an allowlist even when included",
      recent: ["altimate-free/altimate-base", "opencode/nemotron-3-super-free"],
      filter: { "altimate-free": {}, opencode: {} },
      expected: "opencode/nemotron-3-super-free",
    },
    {
      name: "non-managed recent retains precedence outside the allowlist",
      recent: ["opencode/nemotron-3-super-free"],
      filter: { "altimate-backend": {} },
      expected: "opencode/nemotron-3-super-free",
    },
    {
      name: "configured model outranks recents",
      configured: "altimate-free/altimate-base",
      recent: ["opencode/nemotron-3-super-free"],
      expected: "altimate-free/altimate-base",
    },
    { name: "no recents preserves the Base fallback", recent: [], expected: "altimate-free/altimate-base" },
  ])("$name", ({ recent, filter, configured, expected }) => {
    const zen = provider("opencode", ["nemotron-3-super-free"])
    zen.options.apiKey = "public"
    const expectedModel = Provider.parseModel(expected)
    expect(
      ACPService.defaultModelFromConfig(
        configured,
        providers(zen, provider("altimate-free", ["altimate-base"])),
        filter,
        false,
        recent.map(Provider.parseModel),
      ),
    ).toEqual({
      providerID: ProviderV2.ID.make(expectedModel.providerID),
      modelID: ModelV2.ID.make(expectedModel.modelID),
    })
  })

  test.each([
    { flag: true, providerID: "opencode", modelID: "nemotron-3-super-free" },
    { flag: false, providerID: "altimate-free", modelID: "altimate-base" },
    { flag: undefined, providerID: "altimate-free", modelID: "altimate-base" },
    { flag: "yes", providerID: "altimate-free", modelID: "altimate-base" },
  ])("honors persisted default-switch decline flag $flag", async ({ flag, providerID, modelID }) => {
    const stateFile = path.join(Global.Path.state, "model.json")
    const previous = await fs.readFile(stateFile, "utf8").catch(() => undefined)
    try {
      await fs.mkdir(Global.Path.state, { recursive: true })
      await fs.writeFile(stateFile, JSON.stringify({ recent: [], declinedManagedBaseDefault: flag }))
      const zen = provider("opencode", ["big-pickle", "nemotron-3-super-free"])
      zen.options.apiKey = "public"
      const state = await Provider.readDefaultModelState()
      const result = ACPService.defaultModelFromConfig(
        undefined,
        providers(zen, provider("altimate-free", ["altimate-base"])),
        undefined,
        state.declinedManagedBaseDefault,
        state.recent,
      )
      expect(result).toEqual({
        providerID: ProviderV2.ID.make(providerID),
        modelID: ModelV2.ID.make(modelID),
      })
    } finally {
      if (previous === undefined) await fs.rm(stateFile, { force: true })
      else await fs.writeFile(stateFile, previous)
    }
  })

  test("a decline still permits Base as the last resort and as an explicit choice", () => {
    const available = providers(provider("altimate-free", ["altimate-base"]), provider("opencode", ["big-pickle"]))
    for (const configured of [undefined, "altimate-free/altimate-base"]) {
      expect(ACPService.defaultModelFromConfig(configured, available, undefined, true)).toEqual({
        providerID: ProviderV2.ID.make("altimate-free"),
        modelID: ModelV2.ID.make("altimate-base"),
      })
    }
  })

  test("a keyed Zen account outranks registered Altimate Base even with zero-cost models", () => {
    const zen = provider("opencode", ["nemotron-3-super-free"])
    zen.key = "test-zen-key"
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(zen, provider("altimate-free", ["altimate-base"])),
    )
    expect(result?.providerID).toBe(ProviderV2.ID.make("opencode"))
  })

  test("a self-hosted provider with zero-cost metadata still outranks registered Base", () => {
    const local = provider("local-llm", ["llama-3"])
    local.options = { apiKey: "public", baseURL: "http://localhost:11434/v1" }
    const zen = provider("opencode", ["nemotron-3-super-free"])
    zen.options.apiKey = "public"
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(zen, provider("altimate-free", ["altimate-base"]), local),
    )
    expect(result?.providerID).toBe(ProviderV2.ID.make("local-llm"))
  })

  test("public Zen stays available without registered Base or when a provider allowlist excludes Base", () => {
    const zen = provider("opencode", ["nemotron-3-super-free"])
    zen.options.apiKey = "public"
    expect(ACPService.defaultModelFromConfig(undefined, providers(zen))?.providerID).toBe(ProviderV2.ID.make("opencode"))
    expect(
      ACPService.defaultModelFromConfig(
        undefined,
        providers(zen, provider("altimate-free", ["altimate-base"])),
        { opencode: {} },
      )?.providerID,
    ).toBe(ProviderV2.ID.make("opencode"))
  })

  test("an explicitly configured public Zen model still outranks registered Base", () => {
    const zen = provider("opencode", ["nemotron-3-super-free"])
    zen.options.apiKey = "public"
    const result = ACPService.defaultModelFromConfig(
      "opencode/nemotron-3-super-free",
      providers(zen, provider("altimate-free", ["altimate-base"])),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("opencode"),
      modelID: ModelV2.ID.make("nemotron-3-super-free"),
    })
  })

  test("never chooses Big Pickle implicitly", () => {
    expect(
      ACPService.defaultModelFromConfig(undefined, providers(provider("opencode", ["big-pickle"]))),
    ).toBeUndefined()
  })

  test("rejects a configured model that is not available", () => {
    expect(
      ACPService.defaultModelFromConfig("opencode/missing", providers(provider("opencode", ["big-pickle"]))),
    ).toBeUndefined()
  })

  test("does not reintroduce Big Pickle through the ACP snapshot fallback", () => {
    const snapshot = {
      directory: "/tmp/acp-default-model-test",
      providers: {},
      modelOptions: [
        {
          providerID: ProviderV2.ID.make("opencode"),
          providerName: "OpenCode",
          modelID: ModelV2.ID.make("big-pickle"),
          modelName: "Big Pickle",
        },
        {
          providerID: ProviderV2.ID.make("openai"),
          providerName: "OpenAI",
          modelID: ModelV2.ID.make("gpt-5"),
          modelName: "GPT-5",
        },
      ],
      variantsByModel: {},
      availableModes: [],
      defaultModeID: "build",
      availableCommands: [],
    } satisfies Directory.Snapshot

    expect(ACPService.selectDefaultModel(snapshot)).toEqual({
      providerID: ProviderV2.ID.make("openai"),
      modelID: ModelV2.ID.make("gpt-5"),
    })
  })

  test("falls back to another OpenCode model when Altimate Base is not registered", () => {
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("opencode", ["big-pickle", "gpt-5"])),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("opencode"),
      modelID: ModelV2.ID.make("gpt-5"),
    })
  })

  test("skips altimate-backend when an explicit provider allowlist excludes it", () => {
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("altimate-backend", ["altimate-default"]), provider("opencode", ["gpt-5"])),
      { opencode: {} },
    )
    expect(result?.providerID).toBe(ProviderV2.ID.make("opencode"))
  })

  test("a connected paid provider outranks registered Altimate Base", () => {
    // Base logs requests, so absent a configured model or persisted recent, it must never win over
    // something the user actually connected. Otherwise a registered user with an Anthropic key
    // would silently route every new session to the free logging tier.
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("altimate-free", ["altimate-base"]), provider("anthropic", ["claude-sonnet-4"])),
      undefined,
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("anthropic"),
      modelID: ModelV2.ID.make("claude-sonnet-4"),
    })
  })

  test("falls back to Altimate Base when nothing else is connected", () => {
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("altimate-free", ["altimate-base"]), provider("opencode", ["big-pickle"])),
      undefined,
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("altimate-free"),
      modelID: ModelV2.ID.make("altimate-base"),
    })
  })

  test("does not recover an excluded managed provider through the sorted fallback", () => {
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("altimate-free", ["altimate-base"]), provider("opencode", ["big-pickle"])),
      { opencode: {} },
    )
    expect(result).toBeUndefined()
  })

  test("an Altimate Base-only provider block cannot force the managed provider", () => {
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("altimate-free", ["altimate-base"]), provider("openai", ["gpt-5"])),
      { "altimate-free": {} },
    )
    expect(result).toBeUndefined()
  })

  test("honors an explicit provider allowlist that includes altimate-backend", () => {
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("altimate-backend", ["altimate-default"]), provider("opencode", ["gpt-5"])),
      { "altimate-backend": {}, opencode: {} },
    )
    expect(result?.providerID).toBe(ProviderV2.ID.make("altimate-backend"))
  })

  test("a valid configured model takes precedence over the altimate-backend default", () => {
    const result = ACPService.defaultModelFromConfig(
      "opencode/big-pickle",
      providers(provider("altimate-backend", ["altimate-default"]), provider("opencode", ["big-pickle"])),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("opencode"),
      modelID: ModelV2.ID.make("big-pickle"),
    })
  })

  test("returns no snapshot fallback when Big Pickle is the only option", () => {
    const snapshot = {
      directory: "/tmp/acp-big-pickle-only",
      providers: {},
      modelOptions: [
        {
          providerID: ProviderV2.ID.make("opencode"),
          providerName: "OpenCode",
          modelID: ModelV2.ID.make("big-pickle"),
          modelName: "Big Pickle",
        },
      ],
      variantsByModel: {},
      availableModes: [],
      defaultModeID: "build",
      availableCommands: [],
    } satisfies Directory.Snapshot

    expect(ACPService.selectDefaultModel(snapshot)).toBeUndefined()
  })
})
// altimate_change end
