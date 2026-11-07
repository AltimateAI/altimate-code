import { afterEach, describe, expect, spyOn, test } from "bun:test"
import z from "zod"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Tool } from "../../src/tool/tool"
import { Telemetry } from "../../src/altimate/telemetry"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"
import { PermissionNext } from "../../src/permission/next"
import { initTool } from "./tool-fixture"

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

function ctx(ask: () => Promise<void>): any {
  return {
    sessionID: "ses_perm_reject",
    messageID: "msg_perm_reject",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata() {},
    ask,
  }
}

async function run(error: Error) {
  const events: Telemetry.Event[] = []
  spies.push(spyOn(Telemetry, "track").mockImplementation((event) => void events.push(event)))
  const tool = await initTool(
    Tool.define("perm_fixture", {
      description: "Permission rejection fixture",
      parameters: z.object({}),
      async execute(_args, c) {
        await c.ask({ permission: "perm_fixture", patterns: ["*"], always: ["*"], metadata: {} })
        return { title: "", output: "ok", metadata: {} }
      },
    }),
  )
  await expect(
    tool.execute(
      {},
      ctx(async () => {
        throw error
      }),
    ),
  ).rejects.toBeDefined()
  return events
}

describe("user permission rejection telemetry", () => {
  test.each([
    ["PermissionNext.RejectedError toString", new PermissionNext.RejectedError().toString()],
    ["PermissionV1.RejectedError message", new PermissionV1.RejectedError().message],
    ["PermissionV1.CorrectedError message", new PermissionV1.CorrectedError({ feedback: "use glob" }).message],
    ["PermissionNext.CorrectedError toString", new PermissionNext.CorrectedError("no").toString()],
  ])("%s is recognised as a user decision", (_label, raw) => {
    expect(ErrorDetail.isUserPermissionRejection(raw)).toBe(true)
  })

  test.each([
    new PermissionV1.DeniedError({ ruleset: [] }).message,
    "EACCES: permission denied, open '/etc/shadow'",
    "Access denied for user",
    "tool failed: The user rejected permission to use this specific tool call.",
  ])("other permission failures are still reported: %s", (raw) => {
    expect(ErrorDetail.isUserPermissionRejection(raw)).toBe(false)
  })

  test("a rejected prompt emits no core_failure", async () => {
    const events = await run(new PermissionNext.RejectedError())
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({ status: "error" })
    expect(events.some((e) => e.type === "core_failure")).toBe(false)
  })

  test("a config-rule denial still emits core_failure", async () => {
    const events = await run(new PermissionNext.DeniedError([]))
    expect(events.some((e) => e.type === "core_failure")).toBe(true)
  })
})
