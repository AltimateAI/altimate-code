"""Metadata tags — query governance tags from warehouse system tables."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry


_SNOWFLAKE_TAGS_SQL = """
SELECT
    tag_database as database_name,
    tag_schema as schema_name,
    tag_name,
    tag_value,
    object_database,
    object_schema,
    object_name,
    column_name,
    domain as object_type
FROM SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES
WHERE 1=1
{object_filter}
{tag_filter}
ORDER BY object_database, object_schema, object_name, column_name NULLS LAST
LIMIT {limit}
"""

_SNOWFLAKE_LIST_TAGS_SQL = """
SELECT DISTINCT
    tag_database,
    tag_schema,
    tag_name,
    COUNT(*) as usage_count
FROM SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES
GROUP BY tag_database, tag_schema, tag_name
ORDER BY usage_count DESC
LIMIT {limit}
"""


def get_tags(
    warehouse: str,
    object_name: str | None = None,
    tag_name: str | None = None,
    limit: int = 100,
) -> dict:
    """Fetch metadata tags from the warehouse.

    Args:
        warehouse: Connection name
        object_name: Filter to tags on a specific object (table or column)
        tag_name: Filter to a specific tag name
        limit: Maximum results

    Returns:
        Dict with tags list and summary.
    """
    try:
        connector = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {"success": False, "tags": [], "error": f"Connection '{warehouse}' not found."}

    wh_type = "unknown"
    for wh in ConnectionRegistry.list():
        if wh["name"] == warehouse:
            wh_type = wh.get("type", "unknown")
            break

    if wh_type != "snowflake":
        return {
            "success": False,
            "tags": [],
            "error": f"Metadata tags are only available for Snowflake (got {wh_type}). "
                     f"PostgreSQL and DuckDB do not have native tag systems.",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)

            obj_filter = ""
            if object_name:
                parts = object_name.split(".")
                if len(parts) == 3:
                    obj_filter = f"AND object_database = '{parts[0]}' AND object_schema = '{parts[1]}' AND object_name = '{parts[2]}'"
                elif len(parts) == 2:
                    obj_filter = f"AND object_schema = '{parts[0]}' AND object_name = '{parts[1]}'"
                else:
                    obj_filter = f"AND object_name = '{parts[0]}'"

            tag_filter = f"AND tag_name = '{tag_name}'" if tag_name else ""

            sql = _SNOWFLAKE_TAGS_SQL.format(
                object_filter=obj_filter, tag_filter=tag_filter, limit=limit
            )
            rows = connector.execute(sql)
            tags = [dict(r) if not isinstance(r, dict) else r for r in rows]
        finally:
            connector.close()

        # Summarize by tag
        tag_summary: dict[str, int] = {}
        for t in tags:
            tn = t.get("tag_name", "unknown")
            tag_summary[tn] = tag_summary.get(tn, 0) + 1

        return {
            "success": True,
            "tags": tags,
            "tag_count": len(tags),
            "tag_summary": tag_summary,
        }
    except Exception as e:
        return {"success": False, "tags": [], "error": str(e)}


def list_tags(
    warehouse: str,
    limit: int = 50,
) -> dict:
    """List all available tags in the warehouse."""
    try:
        connector = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {"success": False, "tags": [], "error": f"Connection '{warehouse}' not found."}

    wh_type = "unknown"
    for wh in ConnectionRegistry.list():
        if wh["name"] == warehouse:
            wh_type = wh.get("type", "unknown")
            break

    if wh_type != "snowflake":
        return {
            "success": False,
            "tags": [],
            "error": f"Metadata tags are only available for Snowflake (got {wh_type}).",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)
            rows = connector.execute(_SNOWFLAKE_LIST_TAGS_SQL.format(limit=limit))
            tags = [dict(r) if not isinstance(r, dict) else r for r in rows]
        finally:
            connector.close()

        return {"success": True, "tags": tags, "tag_count": len(tags)}
    except Exception as e:
        return {"success": False, "tags": [], "error": str(e)}
