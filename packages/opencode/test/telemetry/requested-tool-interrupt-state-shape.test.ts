// isRequestedToolInterrupt receives a tool part state; error states carry an `error` string
// (MessageV2.ToolStateError). Passing such a state as an inline literal must typecheck.
import { describe, expect, test } from "bun:test"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

describe("ErrorDetail.isRequestedToolInterrupt state shape", () => {
  test("accepts an inline tool error state with its error message", () => {
    expect(
      ErrorDetail.isRequestedToolInterrupt(
        { status: "error", error: "Tool execution aborted", metadata: { interrupted: true } },
        true,
      ),
    ).toBe(true)
    expect(ErrorDetail.isRequestedToolInterrupt({ status: "error", error: "connection refused" }, true)).toBe(false)
  })
})
