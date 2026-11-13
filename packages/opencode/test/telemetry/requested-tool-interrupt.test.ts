// A tool still running when the session's own abort fires (Stop/Esc, dispose, harness abort)
// is closed by the processor as status "error", error "Tool execution aborted",
// metadata.interrupted. That requested cancellation must not become an error_fingerprint
// ("tool <x> aborted" for schema_inspect); unrequested interruptions and real failures must.
import { describe, expect, test } from "bun:test"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

const interrupted = {
  status: "error",
  input: { table: "public.orders" },
  error: "Tool execution aborted",
  metadata: { interrupted: true },
  time: { start: 1, end: 2 },
}

describe("ErrorDetail.isRequestedToolInterrupt", () => {
  test("the reported fingerprint is the processor's interrupted tool part", () => {
    expect(ErrorDetail.describeToolError(interrupted.error).errorMessage).toBe("tool <x> aborted")
  })

  test("a tool interrupted by the session's requested abort is not fingerprinted", () => {
    expect(ErrorDetail.isRequestedToolInterrupt(interrupted, true)).toBe(true)
  })

  test("an interruption the session did not request is still fingerprinted", () => {
    expect(ErrorDetail.isRequestedToolInterrupt(interrupted, false)).toBe(false)
  })

  test("real tool failures are still fingerprinted after a requested abort", () => {
    const failed = { status: "error", error: "connection refused", metadata: {} }
    expect(ErrorDetail.isRequestedToolInterrupt(failed, true)).toBe(false)
    expect(ErrorDetail.isRequestedToolInterrupt({ status: "error", error: "boom" }, true)).toBe(false)
    expect(ErrorDetail.isRequestedToolInterrupt({ status: "completed", metadata: { interrupted: true } }, true)).toBe(
      false,
    )
  })
})
