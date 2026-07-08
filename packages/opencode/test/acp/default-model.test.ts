// altimate_change start — regression guard for the ACP default-model preference. The v1.17.9 merge
// rewrote defaultModelFromConfig and dropped the fork's "prefer altimate-backend/altimate-default"
// behavior, routing ACP clients (Zed/editors) to the opencode provider instead of altimate's backend.
import { describe, expect, test } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "@/provider/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import { defaultModelFromConfig } from "@/acp/service"

const model = (providerID: ProviderID, id: string): Provider.Model => ({
  id: ModelID.make(id),
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
  const providerID = ProviderID.make(id)
  return {
    id: providerID,
    name: id,
    source: "config",
    env: [],
    options: {},
    models: Object.fromEntries(modelIDs.map((m) => [ModelID.make(m), model(providerID, m)])),
  } as Provider.Info
}

const providers = (...infos: Provider.Info[]) =>
  Object.fromEntries(infos.map((p) => [p.id, p])) as Record<ProviderV2.ID, Provider.Info>

describe("ACP defaultModelFromConfig", () => {
  test("prefers altimate-backend/altimate-default when available and no model configured", () => {
    const result = defaultModelFromConfig(
      undefined,
      providers(provider("altimate-backend", ["altimate-default"]), provider("opencode", ["big-pickle"])),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("altimate-backend"),
      modelID: ModelV2.ID.make("altimate-default"),
    })
  })

  test("falls back to opencode when altimate-backend is not present", () => {
    const result = defaultModelFromConfig(undefined, providers(provider("opencode", ["big-pickle"])))
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("opencode"),
      modelID: ModelV2.ID.make("big-pickle"),
    })
  })

  test("skips altimate-backend when an explicit provider allowlist excludes it", () => {
    const result = defaultModelFromConfig(
      undefined,
      providers(provider("altimate-backend", ["altimate-default"]), provider("opencode", ["big-pickle"])),
      { opencode: {} },
    )
    expect(result?.providerID).toBe(ProviderV2.ID.make("opencode"))
  })

  test("honors an explicit provider allowlist that includes altimate-backend", () => {
    const result = defaultModelFromConfig(
      undefined,
      providers(provider("altimate-backend", ["altimate-default"]), provider("opencode", ["big-pickle"])),
      { "altimate-backend": {}, opencode: {} },
    )
    expect(result?.providerID).toBe(ProviderV2.ID.make("altimate-backend"))
  })

  test("a valid configured model takes precedence over the altimate-backend default", () => {
    const result = defaultModelFromConfig(
      "opencode/big-pickle",
      providers(provider("altimate-backend", ["altimate-default"]), provider("opencode", ["big-pickle"])),
    )
    expect(result).toEqual({
      providerID: ProviderV2.ID.make("opencode"),
      modelID: ModelV2.ID.make("big-pickle"),
    })
  })
})
// altimate_change end
