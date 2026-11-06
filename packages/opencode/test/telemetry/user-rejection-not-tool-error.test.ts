import { describe, expect, test } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { Question } from "../../src/question"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

// Telemetry 55e58557cee2275d: declined bash permission prompts were reported as
// error_fingerprint tool errors with error_class "permission".
describe("isUserRejection", () => {
  test.each([
    ["permission rejected (stored part error)", new PermissionNext.RejectedError().toString()],
    ["permission rejected (message)", new PermissionNext.RejectedError().message],
    ["permission corrected", new PermissionNext.CorrectedError("use dbt run instead").toString()],
    ["question dismissed", new Question.RejectedError().message],
  ])("excludes %s", (_, raw) => {
    expect(ErrorDetail.isUserRejection(raw)).toBe(true)
  })

  test.each([
    ["config rule denial", new PermissionNext.DeniedError([]).toString()],
    ["filesystem permission denied", "Error: EACCES: permission denied, open '/etc/x'"],
    ["warehouse permission", "Insufficient privileges: permission denied for table orders"],
    ["rejection text embedded later", "bash failed: The user rejected permission to use this specific tool call."],
  ])("still reports %s", (_, raw) => {
    expect(ErrorDetail.isUserRejection(raw)).toBe(false)
  })
})
