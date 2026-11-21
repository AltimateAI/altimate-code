import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionNext } from "../../src/permission/next"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

// A user declining a permission prompt surfaced as an "edit" error_fingerprint with error_class "permission"
describe("isUserRejection", () => {
  test("user rejections are excluded from tool error fingerprints", () => {
    for (const raw of [
      new PermissionNext.RejectedError().toString(),
      new PermissionNext.CorrectedError("use the other file").toString(),
      new PermissionNext.RejectedError().message,
      new PermissionV1.RejectedError().message,
      new PermissionV1.CorrectedError({ feedback: "no" }).message,
    ]) {
      expect(ErrorDetail.isUserRejection(raw)).toBe(true)
    }
  })

  test("other permission failures are still reported", () => {
    for (const raw of [
      new PermissionNext.DeniedError([]).toString(),
      new PermissionV1.DeniedError({ ruleset: [] }).message,
      "Error: EACCES: permission denied, open '/etc/hosts'",
      "Cannot delete file: permission denied",
      "Tool failed: The user rejected permission to use this specific tool call.",
      "unknown",
    ]) {
      expect(ErrorDetail.isUserRejection(raw)).toBe(false)
    }
  })
})
