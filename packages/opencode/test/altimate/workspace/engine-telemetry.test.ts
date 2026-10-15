import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Telemetry } from "../../../src/altimate/telemetry"
import {
  attachEvent,
  attachSignature,
  connectErrorClass,
  installPromptEvent,
  precedenceEvent,
  resetEngineTelemetryForTests,
  trackAttach,
  trackEngineError,
  trackPrecedence,
  trackRedirect,
} from "../../../src/altimate/workspace/engine-telemetry"

describe("workspace engine telemetry builders", () => {
  let events: any[]
  let spy: ReturnType<typeof spyOn>
  beforeEach(() => {
    events = []
    spy = spyOn(Telemetry, "track").mockImplementation((e) => {
      events.push(e)
    })
    resetEngineTelemetryForTests()
  })
  afterEach(() => {
    spy.mockRestore()
    resetEngineTelemetryForTests()
  })

  test("attach outcomes map to the event with counts, versions and an error class", () => {
    expect(
      attachEvent({ kind: "attached", available: 3, declared: 4, missing: ["x"] }, { engineVersion: "1.2.3" }),
    ).toEqual(
      expect.objectContaining({
        type: "workspace_engine_attach",
        outcome: "attached",
        available: 3,
        declared: 4,
        missing: 1,
        engine_version: "1.2.3",
      }),
    )
    expect(attachEvent({ kind: "engine-missing", declared: 2 })).toEqual(
      expect.objectContaining({ outcome: "engine_missing", declared: 2 }),
    )
    expect(attachEvent({ kind: "engine-too-old", found: "0.9.0" })).toEqual(
      expect.objectContaining({ outcome: "engine_too_old", found_version: "0.9.0" }),
    )
    expect(attachEvent({ kind: "connect-failed", error: "the workspace link could not be read" })).toEqual(
      expect.objectContaining({ outcome: "connect_failed", error_class: "link_unreadable" }),
    )
    expect(attachEvent({ kind: "unbound" })).toEqual(expect.objectContaining({ outcome: "unbound" }))
    expect(connectErrorClass("the workspace engine could not be checked")).toBe("probe_failed")
    expect((attachEvent({ kind: "unbound" }, {}, "ses_x") as any).session_id).toBe("ses_x")
    expect(connectErrorClass("something else")).toBe("other")
  })

  test("an attach is tracked when the outcome changed, not on every turn boundary", () => {
    const attached = { kind: "attached", available: 2 } as const
    expect(trackAttach(attached, undefined)).toBe(true)
    expect(trackAttach(attached, attached)).toBe(false)
    expect(trackAttach({ kind: "attached", available: 3 }, attached)).toBe(true)
    expect(trackAttach({ kind: "engine-missing" }, { kind: "attached", available: 3 })).toBe(true)
    expect(events.map((e) => e.outcome)).toEqual(["attached", "attached", "engine_missing"])
    expect(attachSignature({ kind: "connect-failed", error: "a" })).toBe(
      attachSignature({ kind: "connect-failed", error: "b" }),
    )
  })

  test("the install prompt event carries the offer, the surface and node detection", () => {
    const offer = { reason: "engine-missing" as const, workspaceId: "17", declared: 2 }
    expect(installPromptEvent("shown", offer, { surface: "headless", nodeMajor: 22 })).toEqual(
      expect.objectContaining({
        type: "workspace_engine_install_prompt",
        action: "shown",
        reason: "engine-missing",
        workspace_id: 17,
        declared: 2,
        surface: "headless",
        node_detected: true,
        node_major: 22,
      }),
    )
    const shown = installPromptEvent(
      "shown",
      { reason: "engine-too-old", workspaceId: "x", found: "0.9.0" },
      { nodeMajor: null },
    ) as any
    expect(shown.node_detected).toBe(false)
    expect("node_major" in shown).toBe(false)
    expect("workspace_id" in shown).toBe(false)
    expect(shown.found_version).toBe("0.9.0")
    expect(installPromptEvent("declined", offer)).toEqual(
      expect.objectContaining({ action: "declined", workspace_id: 17 }),
    )
  })

  test("precedence snapshots are tracked per session when they change", () => {
    const shadowed = new Map([
      [
        "snowflake",
        new Map([
          ["sql_execute", {} as any],
          ["sql_explain", {} as any],
        ]),
      ],
      ["dbt", new Map([["dbt_run", {} as any]])],
    ])
    const on: any = { enabled: true, shadowed, extensions: [{ integration: "x", tools: [] }], workspaceId: "7" }
    expect(precedenceEvent(on, { escapeHatch: false, connections: 1 })).toEqual(
      expect.objectContaining({
        type: "workspace_engine_precedence",
        enabled: true,
        shadowed_types: 2,
        shadowed_connections: 1,
        extensions: 1,
        escape_hatch: false,
        workspace_id: 7,
      }),
    )
    expect(trackPrecedence("s1", on, { escapeHatch: false, connections: 1 })).toBe(true)
    expect(trackPrecedence("s1", on, { escapeHatch: false, connections: 1 })).toBe(false) // unchanged
    expect(trackPrecedence("s1", on, { escapeHatch: false, connections: 2 })).toBe(true) // a connection was added locally
    expect(trackPrecedence("s2", on, { escapeHatch: false, connections: 2 })).toBe(true) // another session
    const off: any = { enabled: false, disabledReason: "escape-hatch" as const, shadowed: new Map(), workspaceId: "7" }
    expect(trackPrecedence("s1", off, { escapeHatch: true, connections: 0 })).toBe(true)
    expect(events.at(-1)).toEqual(
      expect.objectContaining({ enabled: false, reason: "escape-hatch", shadowed_types: 0, escape_hatch: true }),
    )
  })

  test("errors are masked and bounded; a refusal names the operation and workspace", () => {
    trackEngineError("attach", "ENOENT: /home/someone/.altimate/engine " + "x".repeat(500))
    const err = events.at(-1)
    expect(err.type).toBe("workspace_engine_error")
    expect(err.stage).toBe("attach")
    expect(err.message.length).toBeLessThanOrEqual(200)
    expect(err.message).not.toContain("/home/someone")
    trackEngineError("precedence", "derive boom", "ses_p")
    expect(events.at(-1)).toEqual(expect.objectContaining({ stage: "precedence", session_id: "ses_p" }))
    trackRedirect("datamate", "status", 9)
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "workspace_engine_redirect",
        tool: "datamate",
        operation: "status",
        outcome: "refused",
        workspace_id: 9,
      }),
    )
  })
})
