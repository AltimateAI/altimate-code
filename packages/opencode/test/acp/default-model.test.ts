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
import { withTestStateHome } from "../fixture/fixture"

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

  // altimate_change — a stale recent pick of the (now fully-broken) keyless public Zen tier is
  // replaced by registered Base rather than replayed (OpenCode Zen rejects that traffic outright
  // as of 2026-09-17); this used to be reversed back when public Zen still worked. Base itself is
  // also no longer excluded from the recents loop by the mere presence of a `config.provider`
  // filter — only a real enabled_providers/disabled_providers verdict can do that, which this
  // `providerFilter` parameter (config.provider) is not.
  test.each([
    {
      name: "registered Base replaces a stale public Zen recent",
      recent: ["opencode/nemotron-3-super-free"],
      expected: "altimate-free/altimate-base",
    },
    { name: "unloaded provider recent is ignored", recent: ["missing/model"], expected: "altimate-free/altimate-base" },
    { name: "missing model recent is ignored", recent: ["opencode/missing"], expected: "altimate-free/altimate-base" },
    { name: "__proto__ provider is ignored", recent: ["__proto__/x"], expected: "altimate-free/altimate-base" },
    { name: "constructor provider is ignored", recent: ["constructor/x"], expected: "altimate-free/altimate-base" },
    { name: "__proto__ model is ignored", recent: ["opencode/__proto__"], expected: "altimate-free/altimate-base" },
    { name: "constructor model is ignored", recent: ["opencode/constructor"], expected: "altimate-free/altimate-base" },
    {
      name: "a stale public Zen recent is skipped in favor of a later valid recent",
      recent: ["missing/model", "opencode/missing", "opencode/nemotron-3-super-free", "altimate-free/altimate-base"],
      expected: "altimate-free/altimate-base",
    },
    {
      name: "Base recent wins regardless of a config.provider filter",
      recent: ["altimate-free/altimate-base", "opencode/nemotron-3-super-free"],
      filter: { "altimate-free": {}, opencode: {} },
      expected: "altimate-free/altimate-base",
    },
    {
      name: "a stale public Zen recent outside the allowlist is still replaced by Base",
      recent: ["opencode/nemotron-3-super-free"],
      filter: { "altimate-backend": {} },
      expected: "altimate-free/altimate-base",
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

  // altimate_change — `declinedManagedBaseDefault` no longer vetoes Base: OpenCode Zen rejects
  // keyless traffic outright, so there's no working public-Zen alternative left to honor a
  // decline with. Every flag value, including `true`, now resolves to Base.
  test.each([
    { flag: true, providerID: "altimate-free", modelID: "altimate-base" },
    { flag: false, providerID: "altimate-free", modelID: "altimate-base" },
    { flag: undefined, providerID: "altimate-free", modelID: "altimate-base" },
    { flag: "yes", providerID: "altimate-free", modelID: "altimate-base" },
  ])("persisted default-switch decline flag $flag no longer vetoes Base", async ({ flag, providerID, modelID }) => {
    // altimate_change — Cursor/cubic review round 5, P2/P3: `Global.Path.state` is not
    // test-isolated on its own (unlike `Global.Path.home`), so writing `model.json` through it
    // directly touched the real developer state directory and raced other tests doing the same.
    // `withTestStateHome` redirects it to a throwaway temp dir (already `mkdir`'d) for the
    // duration of this test; see its declaration in `test/fixture/fixture.ts`.
    await withTestStateHome(async () => {
      const stateFile = path.join(Global.Path.state, "model.json")
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
    })
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

  test.each([{}, { apiKey: "public" }])(
    "a keyed Zen account outranks registered Altimate Base with options %j",
    (options) => {
      const zen = provider("opencode", ["nemotron-3-super-free"])
      zen.key = "test-zen-key"
      zen.options = options
      const result = ACPService.defaultModelFromConfig(
        undefined,
        providers(zen, provider("altimate-free", ["altimate-base"])),
      )
      expect(result?.providerID).toBe(ProviderV2.ID.make("opencode"))
    },
  )

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

  test("public Zen stays available when Base is not registered", () => {
    const zen = provider("opencode", ["nemotron-3-super-free"])
    zen.options.apiKey = "public"
    expect(ACPService.defaultModelFromConfig(undefined, providers(zen))?.providerID).toBe(ProviderV2.ID.make("opencode"))
  })

  // altimate_change — a `config.provider` filter naming only `opencode` used to be read as "this
  // project excludes Base," keeping public Zen available. Base is now excluded only by a real
  // enabled_providers/disabled_providers verdict, so once it's registered it outranks public Zen
  // here too, regardless of this filter.
  test("registered Base outranks public Zen even when a config.provider filter names only opencode", () => {
    const zen = provider("opencode", ["nemotron-3-super-free"])
    zen.options.apiKey = "public"
    expect(
      ACPService.defaultModelFromConfig(
        undefined,
        providers(zen, provider("altimate-free", ["altimate-base"])),
        { opencode: {} },
      )?.providerID,
    ).toBe(ProviderV2.ID.make("altimate-free"))
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

  test("does not reintroduce Big Pickle through the ACP snapshot fallback", async () => {
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

    expect(await ACPService.selectDefaultModel(snapshot)).toEqual({
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

  // altimate_change — a `config.provider` filter that omits `altimate-free` used to suppress Base
  // through the sorted fallback AND the last-resort return. Base is now excluded only by a real
  // enabled_providers/disabled_providers verdict, so with nothing else selectable it is still
  // reachable as the last resort here.
  test("a config.provider filter that omits Base still allows it as the last resort", () => {
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("altimate-free", ["altimate-base"]), provider("opencode", ["big-pickle"])),
      { opencode: {} },
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("altimate-free"),
      modelID: ModelV2.ID.make("altimate-base"),
    })
  })

  test("an Altimate Base-only provider block still resolves to registered Base as the last resort", () => {
    const result = ACPService.defaultModelFromConfig(
      undefined,
      providers(provider("altimate-free", ["altimate-base"]), provider("openai", ["gpt-5"])),
      { "altimate-free": {} },
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("altimate-free"),
      modelID: ModelV2.ID.make("altimate-base"),
    })
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

  test("returns no snapshot fallback when Big Pickle is the only option", async () => {
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

    expect(await ACPService.selectDefaultModel(snapshot)).toBeUndefined()
  })
})
// altimate_change end
