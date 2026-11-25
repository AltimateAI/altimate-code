import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"
import { PermissionNext } from "../../src/permission/next"

// processor.ts stores `error.toString()` on the errored tool part; prompt.ts must not fingerprint user rejections
describe("ErrorDetail.isUserRejection", () => {
  test("user rejecting a permission prompt is not a tool error", () => {
    const rejected = new PermissionNext.RejectedError().toString()
    expect(ErrorDetail.templateErrorMessage(rejected)).toBe(
      "error the user rejected permission to use this <x> tool call",
    )
    expect(ErrorDetail.isUserRejection(rejected)).toBe(true)
    expect(ErrorDetail.isUserRejection(new PermissionNext.CorrectedError("use grep").toString())).toBe(true)
    expect(ErrorDetail.isUserRejection(String(new PermissionV1.RejectedError()))).toBe(true)
    expect(ErrorDetail.isUserRejection(String(new PermissionV1.CorrectedError({ feedback: "no" })))).toBe(true)
  })

  test("other permission failures still report", () => {
    expect(ErrorDetail.isUserRejection(new PermissionNext.DeniedError([]).toString())).toBe(false)
    expect(ErrorDetail.isUserRejection(String(new PermissionV1.DeniedError({ ruleset: [] })))).toBe(false)
    expect(ErrorDetail.isUserRejection("Error: EACCES: permission denied, open '/etc/shadow'")).toBe(false)
    expect(ErrorDetail.isUserRejection("Error: file says The user rejected permission to use this specific tool call.")).toBe(false)
    expect(ErrorDetail.isUserRejection("unknown")).toBe(false)
  })
})
