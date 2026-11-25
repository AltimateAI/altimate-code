import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

// The processor closes still-running tools with this exact state when a generation ends.
const interrupted = { status: "error", error: "Tool execution aborted", metadata: { interrupted: true } }

describe("isRequestedInterruption", () => {
  test("user-requested abort of a running tool is not a tool error", () => {
    expect(ErrorDetail.isRequestedInterruption(interrupted, true)).toBe(true)
  })

  test("interruption the session did not request is still reported", () => {
    expect(ErrorDetail.isRequestedInterruption(interrupted, false)).toBe(false)
  })

  test("ordinary tool errors are still reported after an abort", () => {
    expect(ErrorDetail.isRequestedInterruption({ status: "error", metadata: {} }, true)).toBe(false)
    expect(ErrorDetail.isRequestedInterruption({ status: "error" }, true)).toBe(false)
    expect(ErrorDetail.isRequestedInterruption({ status: "completed", metadata: { interrupted: true } }, true)).toBe(
      false,
    )
    expect(ErrorDetail.isRequestedInterruption(undefined, true)).toBe(false)
  })

  test("the reported fingerprint is the interrupted-tool error", () => {
    expect(ErrorDetail.describeToolError(interrupted.error)).toEqual({
      errorHash: "18cc068fbdbecb19",
      errorMessage: "tool <x> aborted",
    })
  })

  test("prompt loop skips requested interruptions before recording error fingerprints", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../src/session/prompt.ts"), "utf8")
    const guard = src.indexOf("ErrorDetail.isRequestedInterruption(part.state, abort.aborted)) continue")
    const record = src.indexOf("...ErrorDetail.describeToolError(errorMsg)")
    expect(guard).toBeGreaterThan(-1)
    expect(record).toBeGreaterThan(guard)
  })
})
