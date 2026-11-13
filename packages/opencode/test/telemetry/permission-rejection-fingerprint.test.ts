import { describe, expect, test } from "bun:test"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionNext } from "../../src/permission/next"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"

const { isUserPermissionRejection } = ErrorDetail

// The processor stores `error.toString()` on the tool part; prompt.ts fingerprints that string.
describe("user permission rejections are not fingerprinted as tool errors", () => {
  test("rejected and corrected prompts are user rejections", () => {
    expect(isUserPermissionRejection(new PermissionNext.RejectedError().toString())).toBe(true)
    expect(isUserPermissionRejection(new PermissionNext.CorrectedError("use dbt instead").toString())).toBe(true)
    expect(isUserPermissionRejection(String(new PermissionV1.RejectedError()))).toBe(true)
    expect(isUserPermissionRejection(String(new PermissionV1.CorrectedError({ feedback: "no" })))).toBe(true)
  })

  test("rule denials and other permission failures are still reported", () => {
    expect(isUserPermissionRejection(new PermissionNext.DeniedError([]).toString())).toBe(false)
    expect(isUserPermissionRejection(String(new PermissionV1.DeniedError({ ruleset: [] })))).toBe(false)
    expect(isUserPermissionRejection("Error: EACCES: permission denied, open '/usr/lib/driver'")).toBe(false)
    expect(isUserPermissionRejection("pip failed: The user rejected permission to use this specific tool call.")).toBe(
      false,
    )
  })

  test("prompt.ts skips the fingerprint only for user rejections", async () => {
    const src = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
    expect(src).toContain("pendingError = ErrorDetail.isUserPermissionRejection(errorMsg)")
  })
})
