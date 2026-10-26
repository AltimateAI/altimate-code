import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import os from "os"
import { Telemetry } from "../../../src/altimate/telemetry"
import { isWorkspaceClient, trackWorkspaceToolCall } from "../../../src/altimate/workspace/tool-call-telemetry"

describe("workspace integration tool calls", () => {
  let rows: any[]
  let spy: ReturnType<typeof spyOn>
  beforeEach(() => {
    rows = []
    spy = spyOn(Telemetry, "track").mockImplementation((e) => {
      rows.push(e)
    })
    Telemetry.endSession("s1")
  })
  afterEach(() => {
    spy.mockRestore()
    Telemetry.endSession("s1")
    Telemetry.endSession("s0")
    // The singleton context is process-wide: left at s1/42 it would stamp a later suite's
    // session-less rows.
    Telemetry.setContext({ sessionId: "", projectId: "" })
  })

  const call = (
    clientName: string,
    outcome: "success" | "error",
    error?: unknown,
    workspaceId: number | undefined = 42,
  ) =>
    trackWorkspaceToolCall({
      key: `${clientName}_jira_get_issue`,
      clientName,
      sessionID: "s1",
      messageID: "m1",
      workspaceId,
      startedAt: Date.now() - 5,
      outcome,
      error,
    })

  test("the engine client's calls become tool_call rows with via_workspace; a success counts as an integration use", () => {
    expect(call("datamate", "success")).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(
      expect.objectContaining({
        type: "tool_call",
        tool_name: "datamate_jira_get_issue",
        tool_type: "mcp",
        status: "success",
        via_workspace: true,
        workspace_id: 42,
        session_id: "s1",
        message_id: "m1",
      }),
    )
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0)
    expect("error" in rows[0]).toBe(false)
    expect(Telemetry.workspaceUseOf("s1").integrations).toBe(1)
  })

  test("a failed call is a tool_call error row with a masked message and no integration use", () => {
    expect(call("datamate", "error", new Error("boom at /home/someone/secret.txt"))).toBe(true)
    expect(rows[0]).toEqual(expect.objectContaining({ status: "error", via_workspace: true, tool_type: "mcp" }))
    expect(rows[0].error).not.toContain("/home/someone")
    expect(Telemetry.workspaceUseOf("s1").integrations).toBe(0)
    expect(call("datamate", "error", "string failure with token=abc123secret and https://u:pw@host/x?q=1")).toBe(true)
    expect(rows[1].error).toContain("string failure")
    expect(rows[1].error).not.toContain("abc123secret")
    expect(rows[1].error).not.toContain("u:pw@")
  })

  test("a failed call's message loses the user name and host name too", () => {
    const user = os.userInfo().username
    const host = os.hostname()
    expect(call("datamate", "error", `login failed for user=${user} on ${host}`)).toBe(true)
    if (user.length > 2) expect(rows[0].error).not.toContain(`=${user}`)
    if (host.length > 2) expect(rows[0].error).not.toContain(host)
  })

  test("a call whose row could not be tracked reports false", () => {
    spy.mockImplementation(() => {
      throw new Error("sink down")
    })
    expect(call("datamate", "error", "boom")).toBe(false)
  })

  test("the engine key in an unbound turn is not the workspace's; the turn's workspace, not the session's entry, names the row", () => {
    expect(
      trackWorkspaceToolCall({
        key: "datamate_x",
        clientName: "datamate",
        sessionID: "s1",
        messageID: "m",
        workspaceId: undefined,
        startedAt: Date.now(),
        outcome: "success",
      }),
    ).toBe(false)
    expect(rows).toHaveLength(0)
    // The session's current entry says 7 (a replacement turn), but this call ran for turn 42.
    Telemetry.setContext({ sessionId: "s1", projectId: "p1", workspaceId: 7 })
    expect(call("datamate", "success")).toBe(true)
    expect(rows[0].workspace_id).toBe(42)
    Telemetry.setContext({ sessionId: "", projectId: "" })
  })

  test("other MCP clients, standalone datamate servers and registry tool ids are not the workspace's engine", () => {
    expect(call("github", "success")).toBe(false)
    expect(call("filesystem", "error", new Error("x"))).toBe(false)
    expect(call("datamate-acme", "success")).toBe(false) // a standalone datamate server the user configured
    expect(call("datamates", "success")).toBe(false)
    expect(rows).toHaveLength(0)
    expect(Telemetry.workspaceUseOf("s1").integrations).toBe(0)
    // The registry tool `datamate_manager` runs through Tool.define, never through this path, and its
    // id is not the engine's client name either.
    expect(isWorkspaceClient("datamate_manager")).toBe(false)
    expect(isWorkspaceClient("datamate")).toBe(true)
    expect(isWorkspaceClient("Datamate")).toBe(false)
  })
})
