import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { testEffect } from "../lib/effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { Skill } from "../../src/skill"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

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

// The reported task denial (telemetry error_hash f55c9b41d367641d) is the plan agent's own
// task rule rejecting the general subagent, built and formatted as Permission.ask and the
// session processor do it.
it.instance("plan agent denying the general subagent reproduces the reported task error", () =>
  Effect.gen(function* () {
    const plan = (yield* Agent.Service.use((svc) => svc.list())).find((a) => a.name === "plan")!
    expect(Permission.evaluate("task", "general", plan.permission).action).toBe("deny")
    const denied = new PermissionV1.DeniedError({
      ruleset: plan.permission.filter((rule) => Wildcard.match("task", rule.permission)),
    })
    // The tool error reaches the processor as a plain Error, so its text starts with "Error: ".
    const detail = ErrorDetail.describeToolError(new Error(denied.message).toString())
    expect(detail.errorMessage).toBe(
      "error the user has specified a rule which <x> you from <x> this <x> tool call <x> are some of the <x> permission <x> permission task <x>",
    )
    expect(detail.errorHash).toBe("f55c9b41d367641d")
  }),
)

// The plan agent denies some task subagents (general can edit). A plan prompt that tells the
// model to launch one of them makes every such task call fail with a permission denial.
for (const file of ["plan.txt", "plan-mode.txt"]) {
  it.instance(`${file} only directs the plan agent to subagents it may launch`, () =>
    Effect.gen(function* () {
      const text = yield* Effect.promise(() =>
        fs.readFile(path.join(__dirname, "../../src/session/prompt", file), "utf-8"),
      )
      const agents = yield* Agent.Service.use((svc) => svc.list())
      const plan = agents.find((a) => a.name === "plan")
      expect(plan).toBeDefined()
      const named = agents.filter((a) =>
        new RegExp(`\\b${a.name}\\b\`?\\s+(sub)?agent`, "i").test(text),
      )
      expect(named.map((a) => a.name)).toContain("explore")
      for (const agent of named) {
        expect({ agent: agent.name, mode: agent.mode }).toEqual({ agent: agent.name, mode: "subagent" })
        expect({ agent: agent.name, action: Permission.evaluate("task", agent.name, plan!.permission).action }).toEqual({
          agent: agent.name,
          action: "allow",
        })
      }
    }),
  )
}
