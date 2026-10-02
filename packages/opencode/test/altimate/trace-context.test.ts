/**
 * TraceContext binds the trace a client sends with a prompt to the session's turn, so the turn's
 * gateway calls, log lines and telemetry share one id with the client and the backend.
 */
import { describe, expect, test } from "bun:test"
import { TraceContext } from "../../src/altimate/observability/trace-context"
import { LLM } from "../../src/session/llm"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const TRACEPARENT = `00-${TRACE_ID}-b7ad6b7169203331-01`

describe("TraceContext", () => {
  test("binds a valid traceparent to the session", () => {
    TraceContext.bind("ses_bind", TRACEPARENT)
    expect(TraceContext.traceId("ses_bind")).toBe(TRACE_ID)
  })

  test("ignores a malformed traceparent and clears the previous turn's trace", () => {
    TraceContext.bind("ses_clear", TRACEPARENT)
    TraceContext.bind("ses_clear", "not-a-traceparent")
    expect(TraceContext.traceId("ses_clear")).toBeUndefined()
    TraceContext.bind("ses_clear", TRACEPARENT)
    TraceContext.bind("ses_clear", undefined)
    expect(TraceContext.traceId("ses_clear")).toBeUndefined()
  })

  test("sends trace headers only to Altimate providers", () => {
    TraceContext.bind("ses_headers", TRACEPARENT)
    const expected = { traceparent: TRACEPARENT, "x-request-id": TRACE_ID }
    expect(TraceContext.headers("ses_headers", "altimate-backend")).toEqual(expected)
    expect(TraceContext.headers("ses_headers", "altimate-free")).toEqual(expected)
    expect(TraceContext.headers("ses_headers", "anthropic")).toEqual({})
    expect(TraceContext.headers("ses_untraced", "altimate-backend")).toEqual({})
  })

  test("a subagent session inherits its parent's trace", () => {
    TraceContext.bind("ses_parent", TRACEPARENT)
    TraceContext.inherit("ses_child", "ses_parent")
    expect(TraceContext.traceId("ses_child")).toBe(TRACE_ID)
  })

  test("the Altimate Base session header does not displace the trace headers", () => {
    TraceContext.bind("ses_base", TRACEPARENT)
    const headers = LLM.withManagedSessionHeaders("altimate-free", "ses_base", {
      ...TraceContext.headers("ses_base", "altimate-free"),
    })
    expect(headers.traceparent).toBe(TRACEPARENT)
    expect(headers["X-Session-Id"]).toBe("ses_base")
  })
})
