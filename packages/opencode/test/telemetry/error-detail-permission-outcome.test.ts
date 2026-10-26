import { describe, expect, test } from "bun:test"
import { ErrorDetail } from "../../src/altimate/telemetry/error-detail"
import { Telemetry } from "../../src/altimate/telemetry"
import { PermissionNext } from "../../src/permission/next"

// The processor stores a failed tool's error as `error.toString()`, i.e. "Error: <message>".
const asToolError = (e: Error) => e.toString()

describe("shouldFingerprintToolError", () => {
  test("config-rule denial (bash deny rule) is not fingerprinted as a tool error", () => {
    const err = new PermissionNext.DeniedError([{ permission: "bash", pattern: "*", action: "deny" }])
    expect(Telemetry.classifyError(asToolError(err))).toBe("permission")
    expect(ErrorDetail.shouldFingerprintToolError(asToolError(err))).toBe(false)
    expect(ErrorDetail.shouldFingerprintToolError(err.message)).toBe(false)
  })

  test("user rejection outcomes are not fingerprinted", () => {
    expect(ErrorDetail.shouldFingerprintToolError(asToolError(new PermissionNext.RejectedError()))).toBe(false)
    expect(ErrorDetail.shouldFingerprintToolError(asToolError(new PermissionNext.CorrectedError("use grep")))).toBe(
      false,
    )
  })

  test("other permission-class errors are still fingerprinted", () => {
    for (const raw of [
      "Error: EACCES: permission denied, open '/etc/shadow'",
      "Error: HTTP 403 Forbidden",
      "Error: access denied for user",
      "Error: something failed. The user has specified a rule which prevents you from using this specific tool call.",
    ]) {
      expect(ErrorDetail.shouldFingerprintToolError(raw)).toBe(true)
    }
  })
})
