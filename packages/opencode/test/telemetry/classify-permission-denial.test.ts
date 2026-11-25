import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/altimate/telemetry"
import { PermissionNext } from "../../src/permission/next"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

describe("classifyError: permission denials embedding user rules", () => {
  const ruleset = [
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "dbt parse *", action: "allow" },
    { permission: "bash", pattern: "rm -rf *", action: "deny" },
  ] as any

  test("config-rule denial is permission even when a rule pattern mentions parse", () => {
    const msg = new PermissionNext.DeniedError(ruleset).message
    expect(Telemetry.classifyError(msg)).toBe("permission")
    expect(Telemetry.classifyError(`Error: ${msg}`)).toBe("permission")
  })

  test("core v1 denial is permission", () => {
    const msg = new PermissionV1.DeniedError({ ruleset }).message
    expect(Telemetry.classifyError(msg)).toBe("permission")
  })

  test("user rejection with feedback is permission even when feedback mentions syntax", () => {
    const msg = new PermissionNext.CorrectedError("fix the syntax first").message
    expect(Telemetry.classifyError(msg)).toBe("permission")
    expect(Telemetry.classifyError(new PermissionNext.RejectedError().message)).toBe("permission")
  })

  test("genuine parse errors still classify as parse_error", () => {
    expect(Telemetry.classifyError("Parse error at line 3: unexpected token")).toBe("parse_error")
  })
})
