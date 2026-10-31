// A user's Stop/Esc closes every unfinished tool part as "Tool execution aborted"
// with metadata.interrupted. Those parts were reported as `error_fingerprint`
// tool errors ("tool <x> aborted" on warehouse_test). Only interruptions the
// session requested are excluded; every other tool error is still reported.
import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"
import { Telemetry } from "../../src/altimate/telemetry"

// interruptedToolPart (src/session/processor.ts) is the only producer of this tool error.
const INTERRUPTED_ERROR = "Tool execution aborted"

describe("reported warehouse_test fingerprint", () => {
  test("is exactly the fingerprint of an interrupted tool part", () => {
    expect(ErrorDetail.describeToolError(INTERRUPTED_ERROR)).toEqual({
      errorHash: "18cc068fbdbecb19",
      errorMessage: "tool <x> aborted",
    })
    expect(Telemetry.classifyError(INTERRUPTED_ERROR)).toBe("unknown")
  })
})

function toolPart(state: Record<string, unknown>): MessageV2.ToolPart {
  return {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: "warehouse_test",
    state: { input: { name: "wh" }, time: { start: 1, end: 2 }, ...state },
  } as unknown as MessageV2.ToolPart
}

const interrupted = toolPart({ status: "error", error: "Tool execution aborted", metadata: { interrupted: true } })

describe("SessionProcessor.shouldTrackToolError", () => {
  test("a tool interrupted by the session's own abort is not tracked", () => {
    expect(SessionProcessor.shouldTrackToolError(interrupted, true)).toBe(false)
  })

  test("a tool interrupted without a requested abort is still tracked", () => {
    expect(SessionProcessor.shouldTrackToolError(interrupted, false)).toBe(true)
  })

  test("a genuine tool failure is tracked even after the session aborted", () => {
    const failed = toolPart({ status: "error", error: "connection refused", metadata: {} })
    expect(SessionProcessor.shouldTrackToolError(failed, true)).toBe(true)
    expect(SessionProcessor.shouldTrackToolError(failed, false)).toBe(true)
  })
})
