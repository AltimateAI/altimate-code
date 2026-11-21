import { describe, expect, test } from "bun:test"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

const { TOOL_ABORTED_ERROR, describeToolError, isRequestedToolAbort } = ErrorDetail

describe("isRequestedToolAbort", () => {
  test("the aborted-tool error is the reported tool_error fingerprint", () => {
    expect(describeToolError(TOOL_ABORTED_ERROR)).toEqual({
      errorHash: "18cc068fbdbecb19",
      errorMessage: "tool <x> aborted",
    })
  })

  test("excludes a tool the session's own abort interrupted", () => {
    expect(isRequestedToolAbort(TOOL_ABORTED_ERROR, true)).toBe(true)
  })

  test("still reports an aborted tool when the session did not request the abort", () => {
    expect(isRequestedToolAbort(TOOL_ABORTED_ERROR, false)).toBe(false)
  })

  test("still reports other tool errors after a session abort", () => {
    expect(isRequestedToolAbort("oldString not found in content", true)).toBe(false)
    expect(isRequestedToolAbort(undefined, true)).toBe(false)
  })
})
