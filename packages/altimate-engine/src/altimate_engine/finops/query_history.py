"""Query history — fetch and analyze recent query execution from warehouse system tables."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry


# Snowflake QUERY_HISTORY SQL
_SNOWFLAKE_HISTORY_SQL = """
SELECT
    query_id,
    query_text,
    query_type,
    user_name,
    warehouse_name,
    warehouse_size,
    execution_status,
    error_code,
    error_message,
    start_time,
    end_time,
    total_elapsed_time / 1000.0 as execution_time_sec,
    bytes_scanned,
    rows_produced,
    credits_used_cloud_services
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
{user_filter}
{warehouse_filter}
ORDER BY start_time DESC
LIMIT {limit}
"""

# PostgreSQL pg_stat_statements SQL
_POSTGRES_HISTORY_SQL = """
SELECT
    queryid::text as query_id,
    query as query_text,
    'SELECT' as query_type,
    '' as user_name,
    '' as warehouse_name,
    '' as warehouse_size,
    'SUCCESS' as execution_status,
    NULL as error_code,
    NULL as error_message,
    now() as start_time,
    now() as end_time,
    mean_exec_time / 1000.0 as execution_time_sec,
    shared_blks_read * 8192 as bytes_scanned,
    rows as rows_produced,
    0 as credits_used_cloud_services,
    calls as execution_count
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT {limit}
"""

# DuckDB — no native query history, return empty
_DUCKDB_HISTORY_SQL = None

# BigQuery INFORMATION_SCHEMA.JOBS
_BIGQUERY_HISTORY_SQL = """
SELECT
    job_id as query_id,
    query as query_text,
    job_type as query_type,
    user_email as user_name,
    '' as warehouse_name,
    reservation_id as warehouse_size,
    state as execution_status,
    NULL as error_code,
    error_message,
    start_time,
    end_time,
    TIMESTAMP_DIFF(end_time, start_time, SECOND) as execution_time_sec,
    total_bytes_billed as bytes_scanned,
    total_rows as rows_produced,
    0 as credits_used_cloud_services
FROM `region-{location}.INFORMATION_SCHEMA.JOBS`
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
ORDER BY creation_time DESC
LIMIT {limit}
"""

# Databricks system.query.history (Unity Catalog)
_DATABRICKS_HISTORY_SQL = """
SELECT
    query_id,
    query_text,
    statement_type as query_type,
    user_name,
    warehouse_id as warehouse_name,
    '' as warehouse_size,
    status as execution_status,
    NULL as error_code,
    error_message,
    start_time,
    end_time,
    execution_time_ms / 1000.0 as execution_time_sec,
    bytes_read as bytes_scanned,
    rows_produced,
    0 as credits_used_cloud_services
FROM system.query.history
WHERE start_time >= DATE_SUB(CURRENT_TIMESTAMP(), {days})
ORDER BY start_time DESC
LIMIT {limit}
"""


def get_query_history(
    warehouse: str,
    days: int = 7,
    limit: int = 100,
    user: str | None = None,
    warehouse_filter: str | None = None,
) -> dict:
    """Fetch recent query history from a warehouse.

    Args:
        warehouse: Connection name from registry
        days: How many days of history to fetch
        limit: Maximum number of queries to return
        user: Filter to a specific user (Snowflake only)
        warehouse_filter: Filter to a specific warehouse name (Snowflake only)

    Returns:
        Dict with queries list and summary statistics.
    """
    try:
        connector = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {
            "success": False,
            "queries": [],
            "summary": {},
            "error": f"Connection '{warehouse}' not found.",
        }

    # Determine warehouse type
    wh_type = "unknown"
    for wh in ConnectionRegistry.list():
        if wh["name"] == warehouse:
            wh_type = wh.get("type", "unknown")
            break

    sql = _build_history_query(wh_type, days, limit, user, warehouse_filter)
    if sql is None:
        return {
            "success": False,
            "queries": [],
            "summary": {},
            "error": f"Query history is not available for {wh_type} warehouses.",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)
            rows = connector.execute(sql)
        finally:
            connector.close()

        queries = []
        total_bytes = 0
        total_time = 0.0
        error_count = 0

        for row in rows:
            row_dict = dict(row) if not isinstance(row, dict) else row
            queries.append(row_dict)
            total_bytes += row_dict.get("bytes_scanned") or 0
            total_time += row_dict.get("execution_time_sec") or 0.0
            if row_dict.get("execution_status", "").upper() != "SUCCESS":
                error_count += 1

        summary = {
            "query_count": len(queries),
            "total_bytes_scanned": total_bytes,
            "total_execution_time_sec": round(total_time, 2),
            "error_count": error_count,
            "avg_execution_time_sec": round(total_time / len(queries), 2)
            if queries
            else 0,
        }

        return {
            "success": True,
            "queries": queries,
            "summary": summary,
            "warehouse_type": wh_type,
        }
    except Exception as e:
        return {
            "success": False,
            "queries": [],
            "summary": {},
            "error": str(e),
        }


def _build_history_query(
    wh_type: str, days: int, limit: int, user: str | None, warehouse_filter: str | None
) -> str | None:
    if wh_type == "snowflake":
        user_f = f"AND user_name = '{user}'" if user else ""
        wh_f = f"AND warehouse_name = '{warehouse_filter}'" if warehouse_filter else ""
        return _SNOWFLAKE_HISTORY_SQL.format(
            days=days, limit=limit, user_filter=user_f, warehouse_filter=wh_f
        )
    elif wh_type == "postgres":
        return _POSTGRES_HISTORY_SQL.format(limit=limit)
    elif wh_type == "duckdb":
        return _DUCKDB_HISTORY_SQL
    elif wh_type == "bigquery":
        return _BIGQUERY_HISTORY_SQL.format(days=days, limit=limit, location="US")
    elif wh_type == "databricks":
        return _DATABRICKS_HISTORY_SQL.format(days=days, limit=limit)
    return None
