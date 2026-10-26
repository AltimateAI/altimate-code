import { describe, expect, test } from "bun:test"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"
import { ToolResultCap } from "../../src/session/tool-result-cap"

// Mirrors the state SessionProcessor writes for a tool left running/pending when
// the generation is cancelled (processor.ts interruptedToolPart).
const interrupted = (metadata: Record<string, unknown> | undefined) => ({
  status: "error" as const,
  error: "Tool execution aborted",
  metadata: ToolResultCap.capInterruptedMetadata(metadata, 1000),
})

describe("ErrorDetail.isRequestedToolAbort", () => {
  test("interrupted write after a requested session abort is not a tool error", () => {
    expect(ErrorDetail.isRequestedToolAbort(interrupted(undefined), true)).toBe(true)
    expect(ErrorDetail.isRequestedToolAbort({ status: "error", metadata: { interrupted: true } }, true)).toBe(true)
  })

  test("interrupted part without a session abort is still reported", () => {
    expect(ErrorDetail.isRequestedToolAbort(interrupted(undefined), false)).toBe(false)
  })

  test("genuine tool errors during an aborted session are still reported", () => {
    expect(ErrorDetail.isRequestedToolAbort({ status: "error", metadata: {} }, true)).toBe(false)
    expect(ErrorDetail.isRequestedToolAbort({ status: "error" }, true)).toBe(false)
    expect(ErrorDetail.isRequestedToolAbort({ status: "error", metadata: { interrupted: "yes" } }, true)).toBe(false)
  })

  test("non-error parts are unaffected", () => {
    expect(ErrorDetail.isRequestedToolAbort({ status: "completed", metadata: { interrupted: true } }, true)).toBe(false)
  })
})
