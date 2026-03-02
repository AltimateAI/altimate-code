"""Unused resource identification — find stale tables, idle warehouses, and dormant schemas."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry


# ---------------------------------------------------------------------------
# Snowflake SQL templates
# ---------------------------------------------------------------------------

_SNOWFLAKE_UNUSED_TABLES_SQL = """
SELECT
    table_catalog as database_name,
    table_schema as schema_name,
    table_name,
    row_count,
    bytes as size_bytes,
    last_altered,
    created
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS
WHERE active_bytes > 0
  AND table_catalog NOT IN ('SNOWFLAKE')
  AND table_schema NOT IN ('INFORMATION_SCHEMA')
  AND NOT EXISTS (
      SELECT 1
      FROM SNOWFLAKE.ACCOUNT_USAGE.ACCESS_HISTORY ah,
           LATERAL FLATTEN(input => ah.base_objects_accessed) f
      WHERE f.value:"objectName"::string = table_catalog || '.' || table_schema || '.' || table_name
        AND ah.query_start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
  )
ORDER BY size_bytes DESC NULLS LAST
LIMIT {limit}
"""

# Fallback: simpler query without ACCESS_HISTORY (which needs Enterprise+)
_SNOWFLAKE_UNUSED_TABLES_SIMPLE_SQL = """
SELECT
    table_catalog as database_name,
    table_schema as schema_name,
    table_name,
    row_count,
    bytes as size_bytes,
    last_altered,
    created
FROM SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS
WHERE active_bytes > 0
  AND table_catalog NOT IN ('SNOWFLAKE')
  AND table_schema NOT IN ('INFORMATION_SCHEMA')
  AND last_altered < DATEADD('day', -{days}, CURRENT_TIMESTAMP())
ORDER BY size_bytes DESC NULLS LAST
LIMIT {limit}
"""

_SNOWFLAKE_IDLE_WAREHOUSES_SQL = """
SELECT
    name as warehouse_name,
    type,
    size as warehouse_size,
    auto_suspend,
    auto_resume,
    created_on,
    CASE
        WHEN name NOT IN (
            SELECT DISTINCT warehouse_name
            FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
            WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
        ) THEN TRUE
        ELSE FALSE
    END as is_idle
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSES
WHERE deleted_on IS NULL
ORDER BY is_idle DESC, warehouse_name
"""

# ---------------------------------------------------------------------------
# BigQuery SQL templates
# ---------------------------------------------------------------------------

_BIGQUERY_UNUSED_TABLES_SQL = """
SELECT
    table_catalog as database_name,
    table_schema as schema_name,
    table_name,
    row_count,
    size_bytes,
    TIMESTAMP_MILLIS(last_modified_time) as last_altered,
    creation_time as created
FROM `region-{location}.INFORMATION_SCHEMA.TABLE_STORAGE`
WHERE NOT deleted
  AND last_modified_time < UNIX_MILLIS(TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY))
ORDER BY size_bytes DESC
LIMIT {limit}
"""

# ---------------------------------------------------------------------------
# Databricks SQL templates
# ---------------------------------------------------------------------------

_DATABRICKS_UNUSED_TABLES_SQL = """
SELECT
    table_catalog as database_name,
    table_schema as schema_name,
    table_name,
    0 as row_count,
    0 as size_bytes,
    last_altered,
    created
FROM system.information_schema.tables
WHERE last_altered < DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL '{days}' DAY)
ORDER BY last_altered ASC
LIMIT {limit}
"""


def _get_wh_type(warehouse: str) -> str:
    for wh in ConnectionRegistry.list():
        if wh["name"] == warehouse:
            return wh.get("type", "unknown")
    return "unknown"


def find_unused_resources(
    warehouse: str,
    days: int = 30,
    limit: int = 50,
) -> dict:
    """Find unused tables and idle warehouses.

    Looks for:
    - Tables not accessed in the specified period
    - Warehouses with no query activity (Snowflake only)
    """
    try:
        connector = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {"success": False, "error": f"Connection '{warehouse}' not found."}

    wh_type = _get_wh_type(warehouse)

    if wh_type not in ("snowflake", "bigquery", "databricks"):
        return {
            "success": False,
            "error": f"Unused resource detection is not available for {wh_type} warehouses.",
        }

    unused_tables = []
    idle_warehouses = []
    errors = []

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)

            if wh_type == "snowflake":
                unused_tables = _fetch_snowflake_unused_tables(connector, days, limit, errors)
                idle_warehouses = _fetch_snowflake_idle_warehouses(connector, days, errors)
            elif wh_type == "bigquery":
                unused_tables = _fetch_tables(
                    connector,
                    _BIGQUERY_UNUSED_TABLES_SQL.format(days=days, limit=limit, location="US"),
                    errors,
                )
            elif wh_type == "databricks":
                unused_tables = _fetch_tables(
                    connector,
                    _DATABRICKS_UNUSED_TABLES_SQL.format(days=days, limit=limit),
                    errors,
                )
        finally:
            connector.close()

        # Calculate potential savings
        total_stale_bytes = sum(t.get("size_bytes") or 0 for t in unused_tables)
        total_stale_gb = round(total_stale_bytes / (1024 ** 3), 2) if total_stale_bytes else 0

        return {
            "success": True,
            "unused_tables": unused_tables,
            "idle_warehouses": idle_warehouses,
            "summary": {
                "unused_table_count": len(unused_tables),
                "idle_warehouse_count": len(idle_warehouses),
                "total_stale_storage_gb": total_stale_gb,
            },
            "days_analyzed": days,
            "errors": errors if errors else None,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def _fetch_tables(connector, sql: str, errors: list) -> list[dict]:
    """Execute a table query and return results as dicts."""
    try:
        rows = connector.execute(sql)
        return [dict(r) if not isinstance(r, dict) else r for r in rows]
    except Exception as e:
        errors.append(f"Could not query unused tables: {e}")
        return []


def _fetch_snowflake_unused_tables(connector, days: int, limit: int, errors: list) -> list[dict]:
    """Try ACCESS_HISTORY first, fall back to simple query."""
    try:
        rows = connector.execute(_SNOWFLAKE_UNUSED_TABLES_SQL.format(days=days, limit=limit))
        return [dict(r) if not isinstance(r, dict) else r for r in rows]
    except Exception:
        try:
            rows = connector.execute(_SNOWFLAKE_UNUSED_TABLES_SIMPLE_SQL.format(days=days, limit=limit))
            return [dict(r) if not isinstance(r, dict) else r for r in rows]
        except Exception as e:
            errors.append(f"Could not query unused tables: {e}")
            return []


def _fetch_snowflake_idle_warehouses(connector, days: int, errors: list) -> list[dict]:
    """Find idle Snowflake warehouses."""
    try:
        rows = connector.execute(_SNOWFLAKE_IDLE_WAREHOUSES_SQL.format(days=days))
        warehouses = [dict(r) if not isinstance(r, dict) else r for r in rows]
        return [w for w in warehouses if w.get("is_idle")]
    except Exception as e:
        errors.append(f"Could not query idle warehouses: {e}")
        return []
