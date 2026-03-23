/**
 * Tests for finops role-access formatting functions:
 * formatGrants, formatHierarchy, formatUserRoles.
 *
 * These render RBAC data as markdown tables. Incorrect output
 * could cause data engineers to miss security issues during audits.
 * Tests use Dispatcher.call spying to supply known RBAC data.
 */
import { describe, test, expect, spyOn, afterAll, beforeEach } from "bun:test"
import * as Dispatcher from "../../src/altimate/native/dispatcher"
import {
  FinopsRoleGrantsTool,
  FinopsRoleHierarchyTool,
  FinopsUserRolesTool,
} from "../../src/altimate/tools/finops-role-access"
import { SessionID, MessageID } from "../../src/session/schema"

beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

let dispatcherSpy: ReturnType<typeof spyOn>

function mockDispatcher(responses: Record<string, any>) {
  dispatcherSpy?.mockRestore()
  dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation(async (method: string) => {
    if (responses[method]) return responses[method]
    throw new Error(`No mock for ${method}`)
  })
}

afterAll(() => {
  dispatcherSpy?.mockRestore()
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

describe("formatGrants: privilege summary and grant rows", () => {
  test("renders privilege summary and grant table with standard Snowflake fields", async () => {
    mockDispatcher({
      "finops.role_grants": {
        success: true,
        grant_count: 2,
        privilege_summary: { SELECT: 2, INSERT: 1 },
        grants: [
          { grantee_name: "ANALYST", privilege: "SELECT", object_type: "TABLE", object_name: "orders" },
          { grantee_name: "ADMIN", privilege: "INSERT", object_type: "TABLE", object_name: "users" },
        ],
      },
    })

    const tool = await FinopsRoleGrantsTool.init()
    const result = await tool.execute({ warehouse: "test_wh", limit: 100 }, ctx as any)

    expect(result.title).toContain("2 found")
    expect(result.output).toContain("Privilege Summary")
    expect(result.output).toContain("SELECT: 2")
    expect(result.output).toContain("INSERT: 1")
    expect(result.output).toContain("ANALYST | SELECT | TABLE | orders")
    expect(result.output).toContain("ADMIN | INSERT | TABLE | users")
  })

  test("uses fallback field aliases (role, granted_on, name)", async () => {
    mockDispatcher({
      "finops.role_grants": {
        success: true,
        grant_count: 1,
        privilege_summary: {},
        grants: [
          { role: "DBA", privilege: "USAGE", granted_on: "WAREHOUSE", name: "compute_wh" },
        ],
      },
    })

    const tool = await FinopsRoleGrantsTool.init()
    const result = await tool.execute({ warehouse: "test_wh", limit: 100 }, ctx as any)

    // formatGrants should fall back to r.role, r.granted_on, r.name
    expect(result.output).toContain("DBA | USAGE | WAREHOUSE | compute_wh")
  })

  test("handles empty grants array", async () => {
    mockDispatcher({
      "finops.role_grants": {
        success: true,
        grant_count: 0,
        privilege_summary: {},
        grants: [],
      },
    })

    const tool = await FinopsRoleGrantsTool.init()
    const result = await tool.execute({ warehouse: "test_wh", limit: 100 }, ctx as any)

    expect(result.output).toContain("No grants found")
  })

  test("returns error message on Dispatcher failure", async () => {
    mockDispatcher({
      "finops.role_grants": {
        success: false,
        error: "Connection refused",
      },
    })

    const tool = await FinopsRoleGrantsTool.init()
    const result = await tool.execute({ warehouse: "test_wh", limit: 100 }, ctx as any)

    expect(result.title).toContain("FAILED")
    expect(result.output).toContain("Connection refused")
  })
})

describe("formatHierarchy: recursive role tree rendering", () => {
  test("renders two-level nested hierarchy with children key", async () => {
    mockDispatcher({
      "finops.role_hierarchy": {
        success: true,
        role_count: 3,
        hierarchy: [
          {
            name: "SYSADMIN",
            children: [
              { name: "DBA", children: [] },
              { name: "ANALYST", children: [] },
            ],
          },
        ],
      },
    })

    const tool = await FinopsRoleHierarchyTool.init()
    const result = await tool.execute({ warehouse: "test_wh" }, ctx as any)

    expect(result.title).toContain("3 roles")
    expect(result.output).toContain("Role Hierarchy")
    expect(result.output).toContain("SYSADMIN")
    expect(result.output).toContain("-> DBA")
    expect(result.output).toContain("-> ANALYST")
  })

  test("uses granted_roles fallback alias for children", async () => {
    mockDispatcher({
      "finops.role_hierarchy": {
        success: true,
        role_count: 2,
        hierarchy: [
          {
            role: "ACCOUNTADMIN",
            granted_roles: [{ role: "SECURITYADMIN" }],
          },
        ],
      },
    })

    const tool = await FinopsRoleHierarchyTool.init()
    const result = await tool.execute({ warehouse: "test_wh" }, ctx as any)

    // Should use r.role as name and r.granted_roles as children
    expect(result.output).toContain("ACCOUNTADMIN")
    expect(result.output).toContain("-> SECURITYADMIN")
  })

  test("handles empty hierarchy", async () => {
    mockDispatcher({
      "finops.role_hierarchy": {
        success: true,
        role_count: 0,
        hierarchy: [],
      },
    })

    const tool = await FinopsRoleHierarchyTool.init()
    const result = await tool.execute({ warehouse: "test_wh" }, ctx as any)

    expect(result.output).toContain("Role Hierarchy")
    // No roles rendered but header is present
    expect(result.output).not.toContain("->")
  })
})

describe("formatUserRoles: user-role assignment table", () => {
  test("renders user assignments with standard fields", async () => {
    mockDispatcher({
      "finops.user_roles": {
        success: true,
        assignment_count: 2,
        assignments: [
          { grantee_name: "alice@corp.com", role: "ANALYST", granted_by: "SECURITYADMIN" },
          { grantee_name: "bob@corp.com", role: "DBA", granted_by: "ACCOUNTADMIN" },
        ],
      },
    })

    const tool = await FinopsUserRolesTool.init()
    const result = await tool.execute({ warehouse: "test_wh", limit: 100 }, ctx as any)

    expect(result.title).toContain("2 assignments")
    expect(result.output).toContain("User Role Assignments")
    expect(result.output).toContain("alice@corp.com | ANALYST | SECURITYADMIN")
    expect(result.output).toContain("bob@corp.com | DBA | ACCOUNTADMIN")
  })

  test("uses fallback aliases (user_name, role_name, grantor)", async () => {
    mockDispatcher({
      "finops.user_roles": {
        success: true,
        assignment_count: 1,
        assignments: [
          { user_name: "charlie", role_name: "READER", grantor: "ADMIN" },
        ],
      },
    })

    const tool = await FinopsUserRolesTool.init()
    const result = await tool.execute({ warehouse: "test_wh", limit: 100 }, ctx as any)

    // Falls back to r.user_name (via user fallback chain), r.role_name, r.grantor
    expect(result.output).toContain("charlie | READER | ADMIN")
  })

  test("handles empty assignments", async () => {
    mockDispatcher({
      "finops.user_roles": {
        success: true,
        assignment_count: 0,
        assignments: [],
      },
    })

    const tool = await FinopsUserRolesTool.init()
    const result = await tool.execute({ warehouse: "test_wh", limit: 100 }, ctx as any)

    expect(result.output).toContain("No user role assignments found")
  })
})
