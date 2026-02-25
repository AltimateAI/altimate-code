"""Unused resource identification — find stale tables, idle warehouses, and dormant schemas."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry


_UNUSED_TABLES_SQL = """
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
_UNUSED_TABLES_SIMPLE_SQL = """
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

_IDLE_WAREHOUSES_SQL = """
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


def find_unused_resources(
    warehouse: str,
    days: int = 30,
    limit: int = 50,
) -> dict:
    """Find unused tables and idle warehouses.

    Looks for:
    - Tables not accessed in the specified period
    - Warehouses with no query activity
    """
    try:
        connector = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {"success": False, "error": f"Connection '{warehouse}' not found."}

    wh_type = "unknown"
    for wh in ConnectionRegistry.list():
        if wh["name"] == warehouse:
            wh_type = wh.get("type", "unknown")
            break

    if wh_type != "snowflake":
        return {
            "success": False,
            "error": f"Unused resource detection is only available for Snowflake (got {wh_type}).",
        }

    unused_tables = []
    idle_warehouses = []
    errors = []

    try:
        connector.connect()

        # Try ACCESS_HISTORY first, fall back to simple query
        try:
            rows = connector.execute(_UNUSED_TABLES_SQL.format(days=days, limit=limit))
            unused_tables = [dict(r) if not isinstance(r, dict) else r for r in rows]
        except Exception:
            try:
                rows = connector.execute(_UNUSED_TABLES_SIMPLE_SQL.format(days=days, limit=limit))
                unused_tables = [dict(r) if not isinstance(r, dict) else r for r in rows]
            except Exception as e:
                errors.append(f"Could not query unused tables: {e}")

        # Find idle warehouses
        try:
            rows = connector.execute(_IDLE_WAREHOUSES_SQL.format(days=days))
            idle_warehouses = [dict(r) if not isinstance(r, dict) else r for r in rows]
            idle_warehouses = [w for w in idle_warehouses if w.get("is_idle")]
        except Exception as e:
            errors.append(f"Could not query idle warehouses: {e}")

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
