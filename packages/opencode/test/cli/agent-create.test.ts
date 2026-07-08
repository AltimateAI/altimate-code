import { describe, expect, test } from "bun:test"
import {
  AVAILABLE_PERMISSIONS,
  buildAgentDeniedPermissions,
  parseAgentPermissionSelection,
} from "../../src/cli/cmd/agent"

describe("agent create permissions", () => {
  test("keeps list denyable", () => {
    expect(AVAILABLE_PERMISSIONS).toContain("list")

    const permissions = buildAgentDeniedPermissions(["read"])
    expect(permissions.list).toBe("deny")
  })

  test("maps legacy --tools names to permission keys", () => {
    const selected = parseAgentPermissionSelection("write,apply_patch") ?? []

    expect(selected).toEqual(["edit"])
    expect(buildAgentDeniedPermissions(selected).edit).toBeUndefined()
  })
})
