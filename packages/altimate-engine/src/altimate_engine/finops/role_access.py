"""Role & access queries — inspect RBAC grants and permissions."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry


# ---------------------------------------------------------------------------
# Snowflake SQL templates
# ---------------------------------------------------------------------------

_SNOWFLAKE_GRANTS_ON_SQL = """
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
LIMIT {limit}
"""

_SNOWFLAKE_ROLE_HIERARCHY_SQL = """
SELECT
    grantee_name as child_role,
    name as parent_role,
    granted_by,
    created_on
FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES
WHERE granted_on = 'ROLE'
  AND deleted_on IS NULL
ORDER BY parent_role, child_role
"""

_SNOWFLAKE_USER_ROLES_SQL = """
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
LIMIT {limit}
"""

# ---------------------------------------------------------------------------
# BigQuery SQL templates
# ---------------------------------------------------------------------------

_BIGQUERY_GRANTS_SQL = """
SELECT
    privilege_type as privilege,
    object_type,
    object_name,
    grantee as granted_to,
    'NO' as grant_option,
    '' as granted_by,
    '' as created_on
FROM `region-{location}.INFORMATION_SCHEMA.OBJECT_PRIVILEGES`
WHERE 1=1
{grantee_filter}
ORDER BY object_type, object_name
LIMIT {limit}
"""

# ---------------------------------------------------------------------------
# Databricks SQL templates
# ---------------------------------------------------------------------------

_DATABRICKS_GRANTS_SQL = """
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
LIMIT {limit}
"""


def _get_wh_type(warehouse: str) -> str:
    for wh in ConnectionRegistry.list():
        if wh["name"] == warehouse:
            return wh.get("type", "unknown")
    return "unknown"


def _build_grants_sql(wh_type: str, role: str | None, object_name: str | None, limit: int) -> str | None:
    if wh_type == "snowflake":
        role_f = f"AND grantee_name = '{role}'" if role else ""
        obj_f = f"AND name = '{object_name}'" if object_name else ""
        return _SNOWFLAKE_GRANTS_ON_SQL.format(role_filter=role_f, object_filter=obj_f, limit=limit)
    elif wh_type == "bigquery":
        grantee_f = f"AND grantee = '{role}'" if role else ""
        return _BIGQUERY_GRANTS_SQL.format(grantee_filter=grantee_f, limit=limit, location="US")
    elif wh_type == "databricks":
        grantee_f = f"AND grantee = '{role}'" if role else ""
        return _DATABRICKS_GRANTS_SQL.format(grantee_filter=grantee_f, limit=limit)
    return None


def query_grants(
    warehouse: str,
    role: str | None = None,
    object_name: str | None = None,
    limit: int = 100,
) -> dict:
    """Query RBAC grants on a warehouse account.

    Args:
        warehouse: Connection name
        role: Filter to grants for a specific role/grantee
        object_name: Filter to grants on a specific object (Snowflake only)
        limit: Maximum results
    """
    try:
        connector = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {"success": False, "grants": [], "error": f"Connection '{warehouse}' not found."}

    wh_type = _get_wh_type(warehouse)

    sql = _build_grants_sql(wh_type, role, object_name, limit)
    if sql is None:
        return {
            "success": False,
            "grants": [],
            "error": f"Role/access queries are not available for {wh_type} warehouses.",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)
            rows = connector.execute(sql)
            grants = [dict(r) if not isinstance(r, dict) else r for r in rows]
        finally:
            connector.close()

        # Summarize by privilege
        privilege_summary: dict[str, int] = {}
        for g in grants:
            priv = g.get("privilege", "unknown")
            privilege_summary[priv] = privilege_summary.get(priv, 0) + 1

        return {
            "success": True,
            "grants": grants,
            "grant_count": len(grants),
            "privilege_summary": privilege_summary,
        }
    except Exception as e:
        return {"success": False, "grants": [], "error": str(e)}


def query_role_hierarchy(warehouse: str) -> dict:
    """Get the role hierarchy (role-to-role grants).

    Only available for Snowflake. BigQuery and Databricks use IAM/Unity Catalog
    for access management which does not have Snowflake-style role hierarchies.
    """
    try:
        connector = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {"success": False, "error": f"Connection '{warehouse}' not found."}

    wh_type = _get_wh_type(warehouse)
    if wh_type not in ("snowflake",):
        return {
            "success": False,
            "error": f"Role hierarchy is not available for {wh_type}. "
                     f"Use {'BigQuery IAM' if wh_type == 'bigquery' else 'Databricks Unity Catalog' if wh_type == 'databricks' else wh_type} "
                     f"for access management.",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)
            rows = connector.execute(_SNOWFLAKE_ROLE_HIERARCHY_SQL)
            hierarchy = [dict(r) if not isinstance(r, dict) else r for r in rows]
        finally:
            connector.close()

        return {
            "success": True,
            "hierarchy": hierarchy,
            "role_count": len(set(
                r.get("child_role", "") for r in hierarchy
            ) | set(
                r.get("parent_role", "") for r in hierarchy
            )),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def query_user_roles(
    warehouse: str,
    user: str | None = None,
    limit: int = 100,
) -> dict:
    """Get role assignments for users.

    Only available for Snowflake. BigQuery and Databricks use IAM/Unity Catalog
    for access management which does not have Snowflake-style user-role assignments.
    """
    try:
        connector = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {"success": False, "error": f"Connection '{warehouse}' not found."}

    wh_type = _get_wh_type(warehouse)
    if wh_type not in ("snowflake",):
        return {
            "success": False,
            "error": f"User role queries are not available for {wh_type}. "
                     f"Use {'BigQuery IAM' if wh_type == 'bigquery' else 'Databricks Unity Catalog' if wh_type == 'databricks' else wh_type} "
                     f"for access management.",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)
            user_f = f"AND grantee_name = '{user}'" if user else ""
            sql = _SNOWFLAKE_USER_ROLES_SQL.format(user_filter=user_f, limit=limit)
            rows = connector.execute(sql)
            assignments = [dict(r) if not isinstance(r, dict) else r for r in rows]
        finally:
            connector.close()

        return {
            "success": True,
            "assignments": assignments,
            "assignment_count": len(assignments),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}
