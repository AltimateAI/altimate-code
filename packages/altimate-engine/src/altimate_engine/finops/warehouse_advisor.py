"""Warehouse sizing advisor — recommend optimal warehouse configuration."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry


# ---------------------------------------------------------------------------
# Snowflake SQL templates
# ---------------------------------------------------------------------------

_SNOWFLAKE_LOAD_SQL = """
SELECT
    warehouse_name,
    warehouse_size,
    AVG(avg_running) as avg_concurrency,
    AVG(avg_queued_load) as avg_queue_load,
    MAX(avg_queued_load) as peak_queue_load,
    COUNT(*) as sample_count
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
GROUP BY warehouse_name, warehouse_size
ORDER BY avg_queue_load DESC
"""

_SNOWFLAKE_SIZING_SQL = """
SELECT
    warehouse_name,
    warehouse_size,
    COUNT(*) as query_count,
    AVG(total_elapsed_time) / 1000.0 as avg_time_sec,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_elapsed_time) / 1000.0 as p95_time_sec,
    AVG(bytes_scanned) as avg_bytes_scanned,
    SUM(credits_used_cloud_services) as total_credits
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
  AND execution_status = 'SUCCESS'
GROUP BY warehouse_name, warehouse_size
ORDER BY total_credits DESC
"""

# ---------------------------------------------------------------------------
# BigQuery SQL templates
# ---------------------------------------------------------------------------

_BIGQUERY_LOAD_SQL = """
SELECT
    reservation_id as warehouse_name,
    '' as warehouse_size,
    AVG(period_slot_ms / 1000.0) as avg_concurrency,
    0 as avg_queue_load,
    MAX(period_slot_ms / 1000.0) as peak_queue_load,
    COUNT(*) as sample_count
FROM `region-{location}.INFORMATION_SCHEMA.JOBS_TIMELINE`
WHERE period_start >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
GROUP BY reservation_id
ORDER BY avg_concurrency DESC
"""

_BIGQUERY_SIZING_SQL = """
SELECT
    reservation_id as warehouse_name,
    '' as warehouse_size,
    COUNT(*) as query_count,
    AVG(TIMESTAMP_DIFF(end_time, start_time, MILLISECOND)) / 1000.0 as avg_time_sec,
    APPROX_QUANTILES(TIMESTAMP_DIFF(end_time, start_time, MILLISECOND), 100)[OFFSET(95)] / 1000.0 as p95_time_sec,
    AVG(total_bytes_billed) as avg_bytes_scanned,
    SUM(total_bytes_billed) / 1099511627776.0 * 5.0 as total_credits
FROM `region-{location}.INFORMATION_SCHEMA.JOBS`
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
GROUP BY reservation_id
ORDER BY total_credits DESC
"""

# ---------------------------------------------------------------------------
# Databricks SQL templates
# ---------------------------------------------------------------------------

_DATABRICKS_LOAD_SQL = """
SELECT
    warehouse_id as warehouse_name,
    '' as warehouse_size,
    AVG(num_active_sessions) as avg_concurrency,
    AVG(num_queued_queries) as avg_queue_load,
    MAX(num_queued_queries) as peak_queue_load,
    COUNT(*) as sample_count
FROM system.compute.warehouse_events
WHERE event_time >= DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL '{days}' DAY)
GROUP BY warehouse_id
ORDER BY avg_queue_load DESC
"""

_DATABRICKS_SIZING_SQL = """
SELECT
    warehouse_id as warehouse_name,
    '' as warehouse_size,
    COUNT(*) as query_count,
    AVG(total_duration_ms) / 1000.0 as avg_time_sec,
    PERCENTILE(total_duration_ms, 0.95) / 1000.0 as p95_time_sec,
    AVG(read_bytes) as avg_bytes_scanned,
    0 as total_credits
FROM system.query.history
WHERE start_time >= DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL '{days}' DAY)
  AND status = 'FINISHED'
GROUP BY warehouse_id
ORDER BY query_count DESC
"""

_SIZE_ORDER = ["X-Small", "Small", "Medium", "Large", "X-Large", "2X-Large", "3X-Large", "4X-Large"]


def _get_wh_type(warehouse: str) -> str:
    for wh in ConnectionRegistry.list():
        if wh["name"] == warehouse:
            return wh.get("type", "unknown")
    return "unknown"


def _build_load_sql(wh_type: str, days: int) -> str | None:
    if wh_type == "snowflake":
        return _SNOWFLAKE_LOAD_SQL.format(days=days)
    elif wh_type == "bigquery":
        return _BIGQUERY_LOAD_SQL.format(days=days, location="US")
    elif wh_type == "databricks":
        return _DATABRICKS_LOAD_SQL.format(days=days)
    return None


def _build_sizing_sql(wh_type: str, days: int) -> str | None:
    if wh_type == "snowflake":
        return _SNOWFLAKE_SIZING_SQL.format(days=days)
    elif wh_type == "bigquery":
        return _BIGQUERY_SIZING_SQL.format(days=days, location="US")
    elif wh_type == "databricks":
        return _DATABRICKS_SIZING_SQL.format(days=days)
    return None


def advise_warehouse_sizing(
    warehouse: str,
    days: int = 14,
) -> dict:
    """Analyze warehouse usage and recommend sizing changes.

    Examines concurrency, queue load, and query performance to suggest
    right-sizing of warehouses.
    """
    try:
        connector = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {"success": False, "error": f"Connection '{warehouse}' not found."}

    wh_type = _get_wh_type(warehouse)

    load_sql = _build_load_sql(wh_type, days)
    sizing_sql = _build_sizing_sql(wh_type, days)

    if load_sql is None or sizing_sql is None:
        return {
            "success": False,
            "error": f"Warehouse sizing advice is not available for {wh_type} warehouses.",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)

            load_rows = connector.execute(load_sql)
            load_data = [dict(r) if not isinstance(r, dict) else r for r in load_rows]

            sizing_rows = connector.execute(sizing_sql)
            sizing_data = [dict(r) if not isinstance(r, dict) else r for r in sizing_rows]
        finally:
            connector.close()

        recommendations = _generate_sizing_recommendations(load_data, sizing_data)

        return {
            "success": True,
            "warehouse_load": load_data,
            "warehouse_performance": sizing_data,
            "recommendations": recommendations,
            "days_analyzed": days,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def _generate_sizing_recommendations(load_data: list[dict], sizing_data: list[dict]) -> list[dict]:
    """Generate warehouse sizing recommendations."""
    recs = []

    for wh in load_data:
        name = wh.get("warehouse_name", "unknown")
        size = wh.get("warehouse_size", "unknown")
        avg_queue = wh.get("avg_queue_load", 0) or 0
        peak_queue = wh.get("peak_queue_load", 0) or 0
        avg_concurrency = wh.get("avg_concurrency", 0) or 0

        # High queue load -> scale up or enable multi-cluster
        if avg_queue > 1.0:
            recs.append({
                "type": "SCALE_UP",
                "warehouse": name,
                "current_size": size,
                "message": f"Warehouse '{name}' ({size}) has avg queue load of {avg_queue:.1f}. "
                           f"Consider scaling up or enabling multi-cluster warehousing.",
                "impact": "high",
            })
        elif peak_queue > 5.0:
            recs.append({
                "type": "BURST_SCALING",
                "warehouse": name,
                "current_size": size,
                "message": f"Warehouse '{name}' ({size}) has peak queue load of {peak_queue:.1f}. "
                           f"Consider multi-cluster with auto-scale for burst workloads.",
                "impact": "medium",
            })

        # Low utilization -> scale down
        if avg_concurrency < 0.1 and avg_queue < 0.01:
            size_idx = next((i for i, s in enumerate(_SIZE_ORDER) if s.lower() == size.lower()), -1)
            if size_idx > 0:
                suggested = _SIZE_ORDER[size_idx - 1]
                recs.append({
                    "type": "SCALE_DOWN",
                    "warehouse": name,
                    "current_size": size,
                    "suggested_size": suggested,
                    "message": f"Warehouse '{name}' ({size}) is underutilized (avg concurrency {avg_concurrency:.2f}). "
                               f"Consider downsizing to {suggested}.",
                    "impact": "medium",
                })

    if not recs:
        recs.append({
            "type": "HEALTHY",
            "message": "All warehouses appear to be appropriately sized.",
            "impact": "low",
        })

    return recs
