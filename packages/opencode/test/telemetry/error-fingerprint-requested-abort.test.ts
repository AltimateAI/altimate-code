import { describe, expect, test } from "bun:test"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

// Shape written by processor.ts interruptedToolPart when a running tool is closed on abort.
const interrupted = {
  status: "error",
  input: { filePath: "/tmp/x.sql" },
  error: "Tool execution aborted",
  metadata: { interrupted: true },
  time: { start: 1, end: 2 },
}

describe("error_fingerprint: requested tool interruption", () => {
  test("the interrupted-tool error is the reported 'tool <x> aborted' fingerprint", () => {
    expect(ErrorDetail.describeToolError(interrupted.error).errorMessage).toBe("tool <x> aborted")
  })

  test("a tool closed by the session's own abort is not a tool failure", () => {
    expect(ErrorDetail.isRequestedToolInterruption(interrupted, true)).toBe(true)
  })

  test("an interruption the session did not request is still reported", () => {
    expect(ErrorDetail.isRequestedToolInterruption(interrupted, false)).toBe(false)
  })

  test("real tool errors are still reported during an aborted session", () => {
    expect(
      ErrorDetail.isRequestedToolInterruption(
        { status: "error", error: "File not found: /tmp/x.sql", metadata: {} },
        true,
      ),
    ).toBe(false)
    expect(
      ErrorDetail.isRequestedToolInterruption({ status: "error", error: "Tool execution aborted", metadata: {} }, true),
    ).toBe(false)
    expect(ErrorDetail.isRequestedToolInterruption({ status: "completed", metadata: { interrupted: true } }, true)).toBe(
      false,
    )
  })
})
