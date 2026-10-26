// altimate_change start — keep read permissions through both batch context adapters
import { expect, spyOn } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Agent } from "@/agent/agent"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { Session } from "@/session"
import { MessageID, SessionID } from "@/session/schema"
import { BatchTool } from "@/tool/batch"
import { GrepTool } from "@/tool/grep"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer, FSUtil.defaultLayer, Ripgrep.defaultLayer,
  Truncate.defaultLayer, Agent.defaultLayer, Git.defaultLayer,
))

it.instance("batch forwards permissions through the legacy adapter into real grep", () => Effect.gen(function* () {
  const instance = yield* TestInstance
  const visible = path.join(instance.directory, "visible.txt")
  const hidden = path.join(instance.directory, "hidden.txt")
  yield* Effect.promise(() => Promise.all([
    Bun.write(visible, "needle visible"), Bun.write(hidden, "needle secret"),
  ]))
  const grep = yield* (yield* GrepTool).init()
  const batch = yield* (yield* BatchTool).init()
  const permissions = Permission.fromConfig({ "*": "allow", read: { "*": "allow", [hidden]: "deny" } })
  const registry = spyOn(ToolRegistry, "tools").mockResolvedValue([{
    id: "grep", registrySource: undefined, ...grep,
  }])
  const updatePart = Object.assign(async (part: Parameters<typeof Session.updatePart>[0]) => part, Session.updatePart)
  const updates = spyOn(Session, "updatePart").mockImplementation(updatePart)
  try {
    const result = yield* batch.execute({ tool_calls: [{
      tool: "grep", parameters: { pattern: "needle", path: instance.directory },
    }] }, {
      sessionID: SessionID.make("ses_batch_permissions"), messageID: MessageID.make("msg_batch_permissions"),
      agent: "build", abort: AbortSignal.any([]), messages: [], permissions,
      metadata: () => Effect.void,
      ask: (request) => Effect.sync(() => {
        // Both files are decided by the inherited rules, so no read prompt is needed.
        expect(request.permission).not.toBe("read")
      }),
    })
    expect(result.metadata.successful).toBe(1)
    expect(result.metadata.failed).toBe(0)
    const completed = updates.mock.calls.map(([part]) => part)
      .find((part) => part.type === "tool" && part.state.status === "completed")
    const output = completed?.type === "tool" && completed.state.status === "completed" ? completed.state.output : ""
    expect(output).toContain(visible)
    expect(output).toContain("needle visible")
    expect(output).not.toContain(hidden)
    expect(output).not.toContain("needle secret")
  } finally {
    updates.mockRestore()
    registry.mockRestore()
  }
}))
// altimate_change end
