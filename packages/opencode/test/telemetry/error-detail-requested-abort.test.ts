import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

// Regression: cancelling a session while sql_execute ran reported "tool <x> aborted"
// error_fingerprint events, though the tool itself never failed.
describe("isRequestedToolAbort", () => {
  const interrupted = { status: "error", error: "Tool execution aborted", metadata: { interrupted: true } }

  test("interrupted part of a requested session abort is excluded", () => {
    expect(ErrorDetail.isRequestedToolAbort(interrupted, true)).toBe(true)
    expect(ErrorDetail.templateErrorMessage(interrupted.error)).toBe("tool <x> aborted")
  })

  test("interrupts the session did not request are still reported", () => {
    expect(ErrorDetail.isRequestedToolAbort(interrupted, false)).toBe(false)
  })

  test("real tool errors during an aborted session are still reported", () => {
    expect(ErrorDetail.isRequestedToolAbort({ status: "error", metadata: {} }, true)).toBe(false)
    expect(ErrorDetail.isRequestedToolAbort({ status: "error" }, true)).toBe(false)
    expect(ErrorDetail.isRequestedToolAbort({ status: "completed", metadata: { interrupted: true } }, true)).toBe(false)
  })

  test("prompt loop skips requested aborts before recording tool errors", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../src/session/prompt.ts"), "utf8")
    const skip = src.indexOf("ErrorDetail.isRequestedToolAbort(part.state, abort.aborted)")
    const record = src.indexOf('const isError = part.state?.status === "error"')
    expect(skip).toBeGreaterThan(-1)
    expect(record).toBeGreaterThan(skip)
  })
})
