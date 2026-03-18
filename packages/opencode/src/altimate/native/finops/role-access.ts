/**
 * Role & access queries — inspect RBAC grants and permissions.
 *
 * SQL templates ported verbatim from Python altimate_engine.finops.role_access.
 */

import * as Registry from "../connections/registry"
import type {
  RoleGrantsParams,
  RoleGrantsResult,
  RoleHierarchyParams,
  RoleHierarchyResult,
  UserRolesParams,
  UserRolesResult,
} from "../types"

// ---------------------------------------------------------------------------
// Snowflake SQL templates
// ---------------------------------------------------------------------------

const SNOWFLAKE_GRANTS_ON_SQL = `
SELECT
    privilege,
    granted_on as object_type,
    name as object_name,
    grantee_name as granted_to,
    grant_option,
    granted_by,
    created_on
FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES
WHERE 1=1
{role_filter}
{object_filter}
AND deleted_on IS NULL
ORDER BY granted_on, name
LIMIT ?
`

const SNOWFLAKE_ROLE_HIERARCHY_SQL = `
SELECT
    grantee_name as child_role,
    name as parent_role,
    granted_by,
    created_on
FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES
WHERE granted_on = 'ROLE'
  AND deleted_on IS NULL
ORDER BY parent_role, child_role
`

const SNOWFLAKE_USER_ROLES_SQL = `
SELECT
    grantee_name as user_name,
    role as role_name,
    granted_by,
    granted_to as grant_type,
    created_on
FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_USERS
WHERE deleted_on IS NULL
{user_filter}
ORDER BY grantee_name, role
LIMIT ?
`

// ---------------------------------------------------------------------------
// BigQuery SQL templates
// ---------------------------------------------------------------------------

const BIGQUERY_GRANTS_SQL = `
SELECT
    privilege_type as privilege,
    object_type,
    object_name,
    grantee as granted_to,
    'NO' as grant_option,
    '' as granted_by,
    '' as created_on
FROM \`region-US.INFORMATION_SCHEMA.OBJECT_PRIVILEGES\`
WHERE 1=1
{grantee_filter}
ORDER BY object_type, object_name
LIMIT ?
`

// ---------------------------------------------------------------------------
// Databricks SQL templates
// ---------------------------------------------------------------------------

const DATABRICKS_GRANTS_SQL = `
SELECT
    privilege_type as privilege,
    inherited_from as object_type,
    table_name as object_name,
    grantee as granted_to,
    'NO' as grant_option,
    grantor as granted_by,
    '' as created_on
FROM system.information_schema.table_privileges
WHERE 1=1
{grantee_filter}
ORDER BY table_name
LIMIT ?
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWhType(warehouse: string): string {
  const warehouses = Registry.list().warehouses
  const wh = warehouses.find((w) => w.name === warehouse)
  return wh?.type || "unknown"
}

function rowsToRecords(result: { columns: string[]; rows: any[][] }): Record<string, unknown>[] {
  return result.rows.map((row) => {
    const obj: Record<string, unknown> = {}
    result.columns.forEach((col, i) => {
      obj[col] = row[i]
    })
    return obj
  })
}

function buildGrantsSql(
  whType: string, role?: string, objectName?: string, limit: number = 100,
): { sql: string; binds: any[] } | null {
  if (whType === "snowflake") {
    const binds: any[] = []
    const roleF = role ? (binds.push(role), "AND grantee_name = ?") : ""
    const objF = objectName ? (binds.push(objectName), "AND name = ?") : ""
    binds.push(limit)
    return {
      sql: SNOWFLAKE_GRANTS_ON_SQL
        .replace("{role_filter}", roleF)
        .replace("{object_filter}", objF),
      binds,
    }
  }
  if (whType === "bigquery") {
    const binds: any[] = []
    const granteeF = role ? (binds.push(role), "AND grantee = ?") : ""
    binds.push(limit)
    return {
      sql: BIGQUERY_GRANTS_SQL.replace("{grantee_filter}", granteeF),
      binds,
    }
  }
  if (whType === "databricks") {
    const binds: any[] = []
    const granteeF = role ? (binds.push(role), "AND grantee = ?") : ""
    binds.push(limit)
    return {
      sql: DATABRICKS_GRANTS_SQL.replace("{grantee_filter}", granteeF),
      binds,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function queryGrants(params: RoleGrantsParams): Promise<RoleGrantsResult> {
  const whType = getWhType(params.warehouse)
  const limit = params.limit ?? 100

  const built = buildGrantsSql(whType, params.role, params.object_name, limit)
  if (!built) {
    return {
      success: false,
      grants: [],
      grant_count: 0,
      privilege_summary: {},
      error: `Role/access queries are not available for ${whType} warehouses.`,
    }
  }

  try {
    const connector = await Registry.get(params.warehouse)
    const result = await connector.execute(built.sql, limit, built.binds)
    const grants = rowsToRecords(result)

    const privilegeSummary: Record<string, number> = {}
    for (const g of grants) {
      const priv = String(g.privilege || "unknown")
      privilegeSummary[priv] = (privilegeSummary[priv] || 0) + 1
    }

    return {
      success: true,
      grants,
      grant_count: grants.length,
      privilege_summary: privilegeSummary,
    }
  } catch (e) {
    return {
      success: false,
      grants: [],
      grant_count: 0,
      privilege_summary: {},
      error: String(e),
    }
  }
}

export async function queryRoleHierarchy(params: RoleHierarchyParams): Promise<RoleHierarchyResult> {
  const whType = getWhType(params.warehouse)
  if (whType !== "snowflake") {
    return {
      success: false,
      hierarchy: [],
      role_count: 0,
      error: `Role hierarchy is not available for ${whType}. ` +
        `Use ${whType === "bigquery" ? "BigQuery IAM" : whType === "databricks" ? "Databricks Unity Catalog" : whType} ` +
        `for access management.`,
    }
  }

  try {
    const connector = await Registry.get(params.warehouse)
    const result = await connector.execute(SNOWFLAKE_ROLE_HIERARCHY_SQL, 10000)
    const hierarchy = rowsToRecords(result)

    const roles = new Set<string>()
    for (const h of hierarchy) {
      if (h.child_role) roles.add(String(h.child_role))
      if (h.parent_role) roles.add(String(h.parent_role))
    }

    return {
      success: true,
      hierarchy,
      role_count: roles.size,
    }
  } catch (e) {
    return {
      success: false,
      hierarchy: [],
      role_count: 0,
      error: String(e),
    }
  }
}

export async function queryUserRoles(params: UserRolesParams): Promise<UserRolesResult> {
  const whType = getWhType(params.warehouse)
  if (whType !== "snowflake") {
    return {
      success: false,
      assignments: [],
      assignment_count: 0,
      error: `User role queries are not available for ${whType}. ` +
        `Use ${whType === "bigquery" ? "BigQuery IAM" : whType === "databricks" ? "Databricks Unity Catalog" : whType} ` +
        `for access management.`,
    }
  }

  try {
    const connector = await Registry.get(params.warehouse)
    const limit = params.limit ?? 100
    const binds: any[] = []
    const userF = params.user ? (binds.push(params.user), "AND grantee_name = ?") : ""
    binds.push(limit)
    const sql = SNOWFLAKE_USER_ROLES_SQL.replace("{user_filter}", userF)

    const result = await connector.execute(sql, limit, binds)
    const assignments = rowsToRecords(result)

    return {
      success: true,
      assignments,
      assignment_count: assignments.length,
    }
  } catch (e) {
    return {
      success: false,
      assignments: [],
      assignment_count: 0,
      error: String(e),
    }
  }
}

// Exported for SQL template testing
export const SQL_TEMPLATES = {
  SNOWFLAKE_GRANTS_ON_SQL,
  SNOWFLAKE_ROLE_HIERARCHY_SQL,
  SNOWFLAKE_USER_ROLES_SQL,
  BIGQUERY_GRANTS_SQL,
  DATABRICKS_GRANTS_SQL,
  buildGrantsSql,
}
