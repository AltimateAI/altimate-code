import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const FinopsRoleGrantsTool = Tool.define("finops_role_grants", {
  description:
    "Query RBAC grants — see what permissions are granted to roles and on which objects. Snowflake only.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    role: z.string().optional().describe("Filter to grants for a specific role"),
    object_name: z.string().optional().describe("Filter to grants on a specific object"),
    limit: z.number().optional().default(100).describe("Max results"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("finops.role_grants", {
        warehouse: args.warehouse,
        role: args.role,
        object_name: args.object_name,
        limit: args.limit,
      })

      if (!result.success) {
        return {
          title: "Role Grants: FAILED",
          metadata: { success: false, grant_count: 0 },
          output: `Failed to query grants: ${result.error ?? "Unknown error"}`,
        }
      }

      return {
        title: `Role Grants: ${result.grant_count} found`,
        metadata: { success: true, grant_count: result.grant_count },
        output: JSON.stringify({
          privilege_summary: result.privilege_summary,
          grants: result.grants,
        }, null, 2),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Role Grants: ERROR",
        metadata: { success: false, grant_count: 0 },
        output: `Failed to query grants: ${msg}`,
      }
    }
  },
})

export const FinopsRoleHierarchyTool = Tool.define("finops_role_hierarchy", {
  description: "Show the role hierarchy — which roles inherit from which other roles. Snowflake only.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("finops.role_hierarchy", { warehouse: args.warehouse })

      if (!result.success) {
        return {
          title: "Role Hierarchy: FAILED",
          metadata: { success: false, role_count: 0 },
          output: `Failed to query role hierarchy: ${result.error ?? "Unknown error"}`,
        }
      }

      return {
        title: `Role Hierarchy: ${result.role_count} roles`,
        metadata: { success: true, role_count: result.role_count },
        output: JSON.stringify(result.hierarchy, null, 2),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Role Hierarchy: ERROR",
        metadata: { success: false, role_count: 0 },
        output: `Failed to query role hierarchy: ${msg}`,
      }
    }
  },
})

export const FinopsUserRolesTool = Tool.define("finops_user_roles", {
  description: "Show which roles are assigned to users. Snowflake only.",
  parameters: z.object({
    warehouse: z.string().describe("Warehouse connection name"),
    user: z.string().optional().describe("Filter to a specific user"),
    limit: z.number().optional().default(100).describe("Max results"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("finops.user_roles", {
        warehouse: args.warehouse,
        user: args.user,
        limit: args.limit,
      })

      if (!result.success) {
        return {
          title: "User Roles: FAILED",
          metadata: { success: false, assignment_count: 0 },
          output: `Failed to query user roles: ${result.error ?? "Unknown error"}`,
        }
      }

      return {
        title: `User Roles: ${result.assignment_count} assignments`,
        metadata: { success: true, assignment_count: result.assignment_count },
        output: JSON.stringify(result.assignments, null, 2),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "User Roles: ERROR",
        metadata: { success: false, assignment_count: 0 },
        output: `Failed to query user roles: ${msg}`,
      }
    }
  },
})
