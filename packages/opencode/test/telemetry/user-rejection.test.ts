import { describe, expect, test } from "bun:test"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"
import { PermissionNext } from "../../src/permission/next"

// The processor stores a failed tool call's error as `error.toString()`; these are the strings prompt.ts sees.
const rejected = new PermissionNext.RejectedError().toString()
const corrected = new PermissionNext.CorrectedError("use grep instead").toString()
const denied = new PermissionNext.DeniedError([{ permission: "glob", pattern: "*", action: "deny" }]).toString()

describe("ErrorDetail.isUserRejection", () => {
  test("is the reported glob tool_error fingerprint", () => {
    expect(ErrorDetail.templateErrorMessage(rejected)).toBe(
      "error the user rejected permission to use this <x> tool call",
    )
  })

  test("matches a user rejecting a permission prompt, with or without feedback", () => {
    expect(ErrorDetail.isUserRejection(rejected)).toBe(true)
    expect(ErrorDetail.isUserRejection(corrected)).toBe(true)
  })

  test("keeps reporting config denials and other permission failures", () => {
    expect(ErrorDetail.isUserRejection(denied)).toBe(false)
    expect(ErrorDetail.isUserRejection("Error: EACCES: permission denied, scandir '/root'")).toBe(false)
    expect(ErrorDetail.isUserRejection("Error: unknown")).toBe(false)
  })
})
