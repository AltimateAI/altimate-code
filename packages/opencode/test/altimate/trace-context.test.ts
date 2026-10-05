/**
 * TraceContext binds the trace a client sends with a prompt to that prompt's turn (its user
 * message), so the turn's gateway calls, log lines and telemetry share one id with the client
 * and the backend — and nothing outlives the turn or leaks into another one.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { TraceContext } from "../../src/altimate/observability/trace-context"
import { Telemetry } from "../../src/telemetry"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const OTHER_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const SPAN_ID = "b7ad6b7169203331"
const header = (traceId = TRACE_ID, spanId = SPAN_ID) => `00-${traceId}-${spanId}-01`

describe("TraceContext.parse", () => {
  test("accepts a valid traceparent, trimmed", () => {
    expect(TraceContext.parse(`  ${header()} `)).toEqual({ traceId: TRACE_ID, flags: "01" })
  })

  test("ignores what W3C says to ignore", () => {
    for (const invalid of [
      undefined,
      "",
      "not-a-traceparent",
      header("0".repeat(32)), // all-zero trace id
      header(TRACE_ID, "0".repeat(16)), // all-zero parent id
      header(TRACE_ID.toUpperCase()), // upper-case hex
      `01-${TRACE_ID}-${SPAN_ID}-01`, // unknown version
    ]) {
      expect(TraceContext.parse(invalid)).toBeUndefined()
    }
  })
})

describe("TraceContext bindings", () => {
  test("binds a turn, and an invalid header clears an earlier binding for the same message", () => {
    TraceContext.bind("msg_bind", header())
    expect(TraceContext.traceId("msg_bind")).toBe(TRACE_ID)
    for (const invalid of [header("0".repeat(32)), header(TRACE_ID, "0".repeat(16)), undefined]) {
      TraceContext.bind("msg_bind", header())
      TraceContext.bind("msg_bind", invalid)
      expect(TraceContext.traceId("msg_bind")).toBeUndefined()
    }
  })

  test("a subagent turn inherits its parent turn's trace", () => {
    TraceContext.bind("msg_parent", header())
    TraceContext.inherit("msg_child", "msg_parent")
    expect(TraceContext.traceId("msg_child")).toBe(TRACE_ID)
  })

  test("inheriting from an untraced turn clears the child, so a resumed subagent keeps no stale trace", () => {
    TraceContext.bind("msg_old_parent", header())
    TraceContext.inherit("msg_resumed", "msg_old_parent")
    TraceContext.inherit("msg_resumed", "msg_untraced_parent")
    expect(TraceContext.traceId("msg_resumed")).toBeUndefined()
  })

  test("inherited bindings are bounded like direct ones", () => {
    TraceContext.bind("msg_root", header())
    for (let i = 0; i < 2000; i++) TraceContext.inherit(`msg_sub_${i}`, "msg_root")
    expect(TraceContext.size()).toBeLessThanOrEqual(500)
  })

  test("releasing a generation drops exactly the turns it ran", () => {
    TraceContext.bind("msg_ran", header())
    TraceContext.bind("msg_arrived_meanwhile", header(OTHER_TRACE_ID))
    TraceContext.release("ses_release", ["msg_ran"])
    expect(TraceContext.traceId("msg_ran")).toBeUndefined()
    expect(TraceContext.traceId("msg_arrived_meanwhile")).toBe(OTHER_TRACE_ID)
  })

  test("a session's active turn follows the loop and is released with its generation only", () => {
    TraceContext.bind("msg_turn_a", header())
    TraceContext.bind("msg_turn_b", header(OTHER_TRACE_ID))
    TraceContext.activate("ses_active", "msg_turn_a")
    expect(TraceContext.activeTraceId("ses_active")).toBe(TRACE_ID)
    // Overlap: the queued turn B runs next in the same session.
    TraceContext.activate("ses_active", "msg_turn_b")
    expect(TraceContext.activeTraceId("ses_active")).toBe(OTHER_TRACE_ID)
    // An older generation ending does not clear a newer one's active turn.
    TraceContext.release("ses_active", ["msg_turn_a"])
    expect(TraceContext.activeTraceId("ses_active")).toBe(OTHER_TRACE_ID)
    TraceContext.release("ses_active", ["msg_turn_b"])
    expect(TraceContext.activeTraceId("ses_active")).toBeUndefined()
    // An untraced turn has no active trace.
    TraceContext.activate("ses_active", "msg_untraced")
    expect(TraceContext.activeTraceId("ses_active")).toBeUndefined()
  })
})

describe("TraceContext.withHeaders", () => {
  const trace = { traceId: TRACE_ID, flags: "01" }

  test("adds a fresh child span per call for Altimate providers", () => {
    const first = TraceContext.withHeaders({}, trace, "altimate-backend")
    const second = TraceContext.withHeaders({}, trace, "altimate-free")
    const span = (value: string) => /^00-[0-9a-f]{32}-([0-9a-f]{16})-01$/.exec(value)?.[1]
    expect(span(first.traceparent)).toBeDefined()
    expect(span(first.traceparent)).not.toBe(span(second.traceparent))
    expect(first["x-request-id"]).toBe(`${TRACE_ID}-${span(first.traceparent)}`)
  })

  test("never adds headers for other providers or untraced turns", () => {
    expect(TraceContext.withHeaders({ a: "1" }, trace, "anthropic")).toEqual({ a: "1" })
    expect(TraceContext.withHeaders({ a: "1" }, undefined, "altimate-backend")).toEqual({ a: "1" })
  })

  test("treats the two headers as a unit: either one configured keeps both out", () => {
    expect(TraceContext.withHeaders({ "x-request-id": "cfg" }, trace, "altimate-backend")).toEqual({
      "x-request-id": "cfg",
    })
    expect(TraceContext.withHeaders({}, trace, "altimate-backend", { Traceparent: "cfg" })).toEqual({})
  })
})

describe("TraceContext in telemetry envelopes", () => {
  afterEach(async () => {
    await Telemetry.shutdown()
    mock.restore()
  })

  /** Tracks `events`, flushes, and returns the App Insights envelopes that were sent. */
  async function sentEnvelopes(track: () => void): Promise<any[]> {
    const originalDisabled = process.env.ALTIMATE_TELEMETRY_DISABLED
    const originalConnection = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    const bodies: string[] = []
    const fetchMock = spyOn(global, "fetch").mockImplementation((async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? "[]"))
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch)
    try {
      delete process.env.ALTIMATE_TELEMETRY_DISABLED
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=trace-test;IngestionEndpoint=https://example.com"
      // A generation an earlier test file left initialised (disabled, without a sink) would make
      // init() a no-op that drops every event; start a fresh one.
      await Telemetry.shutdown()
      await Telemetry.init()
      track()
      await Telemetry.flush()
      return bodies.flatMap((body) => JSON.parse(body))
    } finally {
      if (originalDisabled !== undefined) process.env.ALTIMATE_TELEMETRY_DISABLED = originalDisabled
      else delete process.env.ALTIMATE_TELEMETRY_DISABLED
      if (originalConnection !== undefined) process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = originalConnection
      else delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      fetchMock.mockRestore()
    }
  }

  const sessionEnd = (sessionId: string) =>
    ({ type: "session_end", timestamp: Date.now(), session_id: sessionId, total_cost: 0, total_tokens: 0, tool_call_count: 0, duration_ms: 1 }) as any

  test("an event of a session running a traced turn carries ai.operation.id, stamped when tracked", async () => {
    TraceContext.bind("msg_tel", header())
    TraceContext.activate("ses_tel", "msg_tel")
    const envelopes = await sentEnvelopes(() => {
      Telemetry.track(sessionEnd("ses_tel"))
      // The turn ends before the flush: the stamp taken at track time must survive.
      TraceContext.release("ses_tel", ["msg_tel"])
    })
    const event = envelopes.find((envelope) => envelope.data?.baseData?.name === "session_end")
    expect(event.tags["ai.operation.id"]).toBe(TRACE_ID)
    expect(event.data.baseData.properties._operation_id).toBeUndefined()
  })

  test("events of other sessions, or with no session of their own, are not stamped", async () => {
    TraceContext.bind("msg_tel_other", header())
    TraceContext.activate("ses_traced", "msg_tel_other")
    Telemetry.setContext({ sessionId: "ses_traced", projectId: "" })
    const envelopes = await sentEnvelopes(() => {
      Telemetry.track(sessionEnd("ses_untraced"))
      Telemetry.track({ type: "first_launch", timestamp: Date.now(), version: "x", is_upgrade: true } as any)
    })
    expect(envelopes.length).toBeGreaterThan(0)
    for (const envelope of envelopes) expect(envelope.tags["ai.operation.id"]).toBeUndefined()
    TraceContext.release("ses_traced", ["msg_tel_other"])
  })
})
