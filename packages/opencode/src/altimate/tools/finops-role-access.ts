import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

function formatGrants(privilegeSummary: unknown, grants: unknown[]): string {
  const lines: string[] = []
  const arr = Array.isArray(grants) ? grants : []

  if (privilegeSummary && typeof privilegeSummary === "object") {
    const summary = privilegeSummary as Record<string, unknown>
    const entries = Object.entries(summary)
    if (entries.length > 0) {
      lines.push("Privilege Summary")
      lines.push("".padEnd(50, "-"))
      for (const [priv, count] of entries) {
        lines.push(`  ${priv}: ${count}`)
      }
      lines.push("")
    }
  }

  if (arr.length === 0) {
    lines.push("No grants found.")
    return lines.join("\n")
  }

  lines.push("Grants")
  lines.push("".padEnd(50, "-"))
  lines.push("Role | Privilege | Object Type | Object")
  lines.push("-----|-----------|-------------|-------")

  for (const g of arr) {
    const r = g as Record<string, unknown>
    const role = String(r.grantee_name ?? r.role ?? "-")
    const priv = String(r.privilege ?? "-")
    const objType = String(r.object_type ?? r.granted_on ?? "-")
    const obj = String(r.object_name ?? r.name ?? "-")
    lines.push(`${role} | ${priv} | ${objType} | ${obj}`)
  }

  return lines.join("\n")
}

function formatHierarchy(hierarchy: unknown): string {
  const lines: string[] = []
  lines.push("Role Hierarchy")
  lines.push("".padEnd(50, "="))

  if (!hierarchy || !Array.isArray(hierarchy)) {
    lines.push("No role hierarchy data.")
    return lines.join("\n")
  }

  function renderRole(role: Record<string, unknown>, indent: number): void {
    const prefix = "  ".repeat(indent)
    const marker = indent === 0 ? "" : "-> "
    const name = String(role.name ?? role.role ?? "unknown")
    lines.push(`${prefix}${marker}${name}`)

    const children = role.children ?? role.granted_roles ?? role.sub_roles
    if (Array.isArray(children)) {
      for (const child of children) {
        renderRole(child as Record<string, unknown>, indent + 1)
      }
    }
  }

  for (const item of hierarchy) {
    if (typeof item === "object" && item !== null) {
      renderRole(item as Record<string, unknown>, 0)
    } else {
      lines.push(String(item))
    }
  }

  return lines.join("\n")
}

function formatUserRoles(assignments: unknown[]): string {
  const arr = Array.isArray(assignments) ? assignments : []
  if (arr.length === 0) return "No user role assignments found."

  const lines: string[] = []
  lines.push("User Role Assignments")
  lines.push("".padEnd(50, "="))
  lines.push("User | Role | Granted By")
  lines.push("-----|------|----------")

  for (const a of arr) {
    const r = a as Record<string, unknown>
    const user = String(r.grantee_name ?? r.user ?? r.user_name ?? "-")
    const role = String(r.role ?? r.role_name ?? "-")
    const grantedBy = String(r.granted_by ?? r.grantor ?? "-")
    lines.push(`${user} | ${role} | ${grantedBy}`)
  }

  return lines.join("\n")
}

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
      const result = await Dispatcher.call("finops.role_grants", {
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
        output: formatGrants(result.privilege_summary, result.grants as unknown[]),
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
      const result = await Dispatcher.call("finops.role_hierarchy", { warehouse: args.warehouse })

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
        output: formatHierarchy(result.hierarchy),
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
      const result = await Dispatcher.call("finops.user_roles", {
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
        output: formatUserRoles(result.assignments as unknown[]),
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
