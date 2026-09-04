import { afterEach, beforeEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { PromptProfiles } from "../../src/altimate/prompts/profiles"
import { EXPECTED_SHA256, sha256 } from "../altimate/prompt-identity"

// Registry-level tests for the opt-in data-qa profile (workload-adaptive
// harness PR 1). Exercises the REAL Agent service (config load + agent list
// build) — the same code path `session/llm.ts` reads `input.agent.prompt` from.

const agentLayer = () =>
  Agent.layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(RuntimeFlags.layer({})),
  )

const it = testEffect(agentLayer())

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

const savedEnv = process.env["ALTIMATE_DATA_QA_PROFILE"]

beforeEach(() => {
  delete process.env["ALTIMATE_DATA_QA_PROFILE"]
})

afterEach(async () => {
  if (savedEnv === undefined) delete process.env["ALTIMATE_DATA_QA_PROFILE"]
  else process.env["ALTIMATE_DATA_QA_PROFILE"] = savedEnv
  await disposeAllInstances()
})

it.instance("with no selection mechanism engaged, data-qa does not exist and builder carries the pinned bytes", () =>
  Effect.gen(function* () {
    const agents = yield* load((svc) => svc.list())
    expect(agents.map((a) => a.name)).not.toContain("data-qa")
    const dataQa = yield* load((svc) => svc.get("data-qa"))
    expect(dataQa).toBeUndefined()
    // The default profile the product actually serves is byte-identical to the
    // pre-split builder.txt.
    const builder = yield* load((svc) => svc.get("builder"))
    expect(builder?.prompt).toBe(PromptProfiles.PROMPT_BUILDER)
    expect(sha256(builder?.prompt ?? "")).toBe(EXPECTED_SHA256)
  }),
)

it.instance("ALTIMATE_DATA_QA_PROFILE=1 registers data-qa as an explicitly selectable agent", () =>
  Effect.gen(function* () {
    process.env["ALTIMATE_DATA_QA_PROFILE"] = "1"
    const dataQa = yield* load((svc) => svc.get("data-qa"))
    expect(dataQa).toBeDefined()
    expect(dataQa?.mode).toBe("primary")
    expect(dataQa?.prompt).toBe(PromptProfiles.PROMPT_DATA_QA)
    // Opt-in registration must not disturb the default profile.
    const builder = yield* load((svc) => svc.get("builder"))
    expect(sha256(builder?.prompt ?? "")).toBe(EXPECTED_SHA256)
    // The default agent remains builder even with the flag set — data-qa is
    // never selected implicitly.
    const fallback = yield* load((svc) => svc.defaultAgent())
    expect(fallback).toBe("builder")
  }),
)

it.instance(
  "an explicit agent config entry for data-qa also opts in (native profile + config overlay)",
  () =>
    Effect.gen(function* () {
      // No env flag — the config entry itself is the explicit opt-in. The
      // native profile registers and the standard config merge overlays it, so
      // the user gets the real data-qa prompt rather than a bare custom agent.
      const dataQa = yield* load((svc) => svc.get("data-qa"))
      expect(dataQa).toBeDefined()
      expect(dataQa?.native).toBe(true)
      expect(dataQa?.prompt).toBe(PromptProfiles.PROMPT_DATA_QA)
      // Still nothing implicit: the default agent remains builder.
      const fallback = yield* load((svc) => svc.defaultAgent())
      expect(fallback).toBe("builder")
    }),
  {
    config: {
      agent: {
        "data-qa": {
          description: "opted in via config",
        },
      },
    },
  },
)

it.instance(
  "default_agent: \"data-qa\" with no flag and no agent entry also opts in and resolves as default",
  () =>
    Effect.gen(function* () {
      // No env flag, no `agent.data-qa` entry — naming data-qa as the
      // configured default is itself the explicit opt-in. Without this path
      // registration is skipped and defaultInfo() throws `default agent
      // "data-qa" not found` (Codex/cubic finding, agent.ts:331).
      const dataQa = yield* load((svc) => svc.get("data-qa"))
      expect(dataQa).toBeDefined()
      expect(dataQa?.native).toBe(true)
      expect(dataQa?.prompt).toBe(PromptProfiles.PROMPT_DATA_QA)
      const fallback = yield* load((svc) => svc.defaultAgent())
      expect(fallback).toBe("data-qa")
    }),
  {
    config: {
      default_agent: "data-qa",
    },
  },
)
