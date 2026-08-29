/**
 * Carry-forward regression guard: the fork's agent modes + bash safety
 * permission defaults survived the OpenCode v1.17.9 upstream merge.
 *
 * Setup mirrors test/agent/agent.test.ts (the supported way to boot the Agent
 * Effect service in tests). We assert:
 *  - the 4 fork agent modes (builder/analyst/plan/reviewer) are registered;
 *  - the `build` -> `builder` back-compat alias resolves;
 *  - destructive DDL is DENIED and cannot be overridden by a user wildcard
 *    allow (the non-overridable safetyDenials merged last, last-match-wins);
 *  - destructive shell ops default to "ask";
 *  - the reviewer agent never mutates (edit/write denied, bash asks — #978
 *    relaxed bash from deny to ask so `gh pr view` works with user approval)
 *    but allows dbt_pr_review.
 */
import { afterEach, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { disposeAllInstances } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { Agent } from "../../../src/agent/agent"
import { Auth } from "../../../src/auth"
import { Config } from "../../../src/config/config"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { Permission } from "../../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Plugin } from "../../../src/plugin"
import { Provider } from "../../../src/provider/provider"
import { Skill } from "../../../src/skill"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"

const agentLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Agent.layer.pipe(
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(LocationServiceMap.layer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const it = testEffect(agentLayer())

function evalPerm(agent: Agent.Info | undefined, tool: string, pattern = "*"): PermissionV1.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(tool, pattern, agent.permission).action
}

function load<A>(fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Agent.Service.use(fn)
}

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("registers the 4 fork agent modes", () =>
  Effect.gen(function* () {
    const names = (yield* load((svc) => svc.list())).map((a) => a.name)
    expect(names).toContain("builder")
    expect(names).toContain("analyst")
    expect(names).toContain("plan")
    expect(names).toContain("reviewer")
  }),
)

it.instance('"build" resolves to the "builder" agent (back-compat alias)', () =>
  Effect.gen(function* () {
    const build = yield* load((svc) => svc.get("build"))
    const builder = yield* load((svc) => svc.get("builder"))
    expect(build).toBeDefined()
    expect(build?.name).toBe("builder")
    expect(build?.name).toBe(builder?.name)
  }),
)

it.instance("default agent is a primary agent (builder by default)", () =>
  Effect.gen(function* () {
    const name = yield* load((svc) => svc.defaultAgent())
    expect(name).toBe("builder")
  }),
)

it.instance("builder denies destructive DDL and defaults destructive shell to ask", () =>
  Effect.gen(function* () {
    const builder = yield* load((svc) => svc.get("builder"))
    expect(builder).toBeDefined()
    // DDL is denied outright (both upper + lower case patterns installed)
    expect(Permission.evaluate("terminal", "DROP DATABASE prod", builder!.permission).action).toBe("deny")
    expect(Permission.evaluate("terminal", "drop schema staging", builder!.permission).action).toBe("deny")
    expect(Permission.evaluate("terminal", "TRUNCATE events", builder!.permission).action).toBe("deny")
    // Destructive file/git ops default to "ask"
    expect(Permission.evaluate("terminal", "rm -rf ./build", builder!.permission).action).toBe("ask")
    expect(Permission.evaluate("terminal", "git push --force origin main", builder!.permission).action).toBe("ask")
    // Bare bash defaults to "ask", not "allow"
    expect(evalPerm(builder, "bash")).toBe("ask")
  }),
)

it.instance(
  "DDL deny cannot be overridden by a user bash wildcard allow (non-overridable safety)",
  () =>
    Effect.gen(function* () {
      const builder = yield* load((svc) => svc.get("builder"))
      expect(builder).toBeDefined()
      // Even though the user set bash: allow, DDL stays denied (last-match-wins safetyDenials)
      expect(evalPerm(builder, "bash")).toBe("allow")
      expect(Permission.evaluate("terminal", "DROP DATABASE prod", builder!.permission).action).toBe("deny")
      expect(Permission.evaluate("terminal", "drop database prod", builder!.permission).action).toBe("deny")
    }),
  {
    config: {
      permission: {
        bash: "allow",
      },
    },
  },
)

it.instance("sql_execute_write DDL is denied (write safety)", () =>
  Effect.gen(function* () {
    const builder = yield* load((svc) => svc.get("builder"))
    expect(builder).toBeDefined()
    expect(Permission.evaluate("sql_execute_write", "DROP DATABASE x", builder!.permission).action).toBe("deny")
    expect(Permission.evaluate("sql_execute_write", "truncate y", builder!.permission).action).toBe("deny")
  }),
)

it.instance("reviewer agent never mutates (edit/write deny, bash asks) but allows the verdict engine", () =>
  Effect.gen(function* () {
    const reviewer = yield* load((svc) => svc.get("reviewer"))
    expect(reviewer).toBeDefined()
    expect(reviewer?.mode).toBe("primary")
    // #978: bash asks (user approves each command, e.g. `gh pr view`) — never runs silently
    expect(evalPerm(reviewer, "bash")).toBe("ask")
    expect(Permission.evaluate("terminal", "DROP DATABASE prod", reviewer!.permission).action).toBe("deny")
    expect(evalPerm(reviewer, "edit")).toBe("deny")
    expect(evalPerm(reviewer, "write")).toBe("deny")
    // The dbt PR review verdict engine + read-only analysis tools are allowed
    expect(evalPerm(reviewer, "dbt_pr_review")).toBe("allow")
    expect(evalPerm(reviewer, "impact_analysis")).toBe("allow")
    expect(evalPerm(reviewer, "read")).toBe("allow")
  }),
)
