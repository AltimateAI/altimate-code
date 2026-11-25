// altimate_change start — upstream_fix: match file permission rules without case on macOS (anomalyco/opencode#64626)
import { afterEach, describe, expect, test } from "bun:test"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionEvaluate } from "../../src/permission/evaluate"

const platform = process.platform
const setPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { value })

const rules: PermissionV1.Ruleset = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "edit", pattern: ".opencode/*", action: "ask" },
  { permission: "read", pattern: "*.env", action: "ask" },
  { permission: "external_directory", pattern: "/Users/x/private/*", action: "deny" },
  { permission: "sensitive_write", pattern: ".git/*", action: "ask" },
  { permission: "bash", pattern: "git push*", action: "ask" },
]

describe("permission rules on case-insensitive file systems", () => {
  afterEach(() => setPlatform(platform))

  test("ignoresCase applies only to file path permissions on macOS", () => {
    for (const permission of ["read", "edit", "external_directory", "sensitive_write"])
      expect(PermissionEvaluate.ignoresCase(permission, "darwin")).toBe(true)
    expect(PermissionEvaluate.ignoresCase("bash", "darwin")).toBe(false)
    expect(PermissionEvaluate.ignoresCase("read", "linux")).toBe(false)
  })

  test("macOS matches file rules whatever the case of the path", () => {
    setPlatform("darwin")
    expect(PermissionEvaluate.evaluate("edit", ".OPENCODE/plugins/guard.ts", rules).action).toBe("ask")
    expect(PermissionEvaluate.evaluate("read", "/repo/Secrets.ENV", rules).action).toBe("ask")
    expect(PermissionEvaluate.evaluate("external_directory", "/users/X/Private/key", rules).action).toBe("deny")
    expect(PermissionEvaluate.evaluate("sensitive_write", ".GIT/hooks/pre-commit", rules).action).toBe("ask")
  })

  test("macOS keeps the case of commands", () => {
    setPlatform("darwin")
    expect(PermissionEvaluate.evaluate("bash", "GIT PUSH origin main", rules).action).toBe("allow")
    expect(PermissionEvaluate.evaluate("bash", "git push origin main", rules).action).toBe("ask")
  })

  test("Linux keeps matching file rules with case", () => {
    setPlatform("linux")
    expect(PermissionEvaluate.evaluate("edit", ".OPENCODE/plugins/guard.ts", rules).action).toBe("allow")
    expect(PermissionEvaluate.evaluate("read", "/repo/Secrets.ENV", rules).action).toBe("allow")
    expect(PermissionEvaluate.evaluate("edit", ".opencode/plugins/guard.ts", rules).action).toBe("ask")
  })
})
// altimate_change end
