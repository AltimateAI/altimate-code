// altimate_change - new file
import { describe, expect, test } from "bun:test"
import { WorkspaceRole } from "../../../src/altimate/workspace/role"

describe("workspace role", () => {
  test("the server's role is used as sent", () => {
    expect(WorkspaceRole.roleOf({ is_owner: false, role: "admin" })).toBe("admin")
    expect(WorkspaceRole.roleOf({ is_owner: true, role: "owner" })).toBe("owner")
    expect(WorkspaceRole.roleOf({ is_owner: false, role: "member" })).toBe("member")
  })

  test("without a role (an older server), or with one this version does not know, is_owner decides", () => {
    expect(WorkspaceRole.roleOf({ is_owner: true })).toBe("owner")
    expect(WorkspaceRole.roleOf({ is_owner: false, role: null })).toBe("member")
    expect(WorkspaceRole.roleOf({ is_owner: false, role: "reviewer" })).toBe("member")
  })

  test("owners and admins manage; members do not", () => {
    expect(WorkspaceRole.manages({ is_owner: false, role: "admin" })).toBe(true)
    expect(WorkspaceRole.manages({ is_owner: true })).toBe(true)
    expect(WorkspaceRole.manages({ is_owner: false, role: "member" })).toBe(false)
    expect(WorkspaceRole.manages({ is_owner: false })).toBe(false)
  })
})
