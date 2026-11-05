// altimate_change start — which agent rulesets turn on the bash external_directory path guard
import { afterEach, expect } from "bun:test"
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
import { externalDirectoryDenied } from "../../src/tool/bash"
import { Permission } from "../../src/permission"

const it = testEffect(
  Agent.layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(RuntimeFlags.layer({})),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("no built-in agent that can run bash turns the guard on without configuration", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service.use((svc) => svc.list())
    expect(agents.length).toBeGreaterThan(0)
    // The guard only engages where external_directory is already denied for "*". Among the
    // built-in agents those are the ones whose ruleset denies everything, bash included, so no
    // built-in agent that can run bash changes behaviour.
    for (const agent of agents) {
      if (!externalDirectoryDenied(agent.permission)) continue
      expect([agent.name, Permission.evaluate("bash", "*", agent.permission).action]).toEqual([agent.name, "deny"])
    }
    for (const name of ["builder", "general", "plan", "reviewer", "explore"])
      expect([name, externalDirectoryDenied(agents.find((agent) => agent.name === name)!.permission)]).toEqual([
        name,
        false,
      ])
  }),
)

it.instance(
  "configured external_directory: deny turns the guard on",
  () =>
    Effect.gen(function* () {
      const builder = yield* Agent.Service.use((svc) => svc.get("builder"))
      expect(externalDirectoryDenied(builder!.permission)).toBe(true)
    }),
  { config: { permission: { external_directory: "deny" } } },
)

it.instance(
  "configured external_directory: allow leaves the guard off",
  () =>
    Effect.gen(function* () {
      const builder = yield* Agent.Service.use((svc) => svc.get("builder"))
      expect(externalDirectoryDenied(builder!.permission)).toBe(false)
    }),
  { config: { permission: { external_directory: "allow" } } },
)

it.instance(
  "configured external_directory: ask with a narrower deny leaves the guard off",
  () =>
    Effect.gen(function* () {
      const builder = yield* Agent.Service.use((svc) => svc.get("builder"))
      expect(externalDirectoryDenied(builder!.permission)).toBe(false)
    }),
  { config: { permission: { external_directory: { "*": "ask", "/srv/*": "deny" } } } },
)
// altimate_change end
