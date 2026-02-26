"""Warehouse sizing advisor — recommend optimal warehouse configuration."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry


_WAREHOUSE_LOAD_SQL = """
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

_WAREHOUSE_SIZING_SQL = """
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

_SIZE_ORDER = ["X-Small", "Small", "Medium", "Large", "X-Large", "2X-Large", "3X-Large", "4X-Large"]


def advise_warehouse_sizing(
    warehouse: str,
    days: int = 14,
) -> dict:
    """Analyze warehouse usage and recommend sizing changes.

    Examines concurrency, queue load, and query performance to suggest
    right-sizing of Snowflake warehouses.
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
            "error": f"Warehouse sizing advice is only available for Snowflake (got {wh_type}).",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)

            load_rows = connector.execute(_WAREHOUSE_LOAD_SQL.format(days=days))
            load_data = [dict(r) if not isinstance(r, dict) else r for r in load_rows]

            sizing_rows = connector.execute(_WAREHOUSE_SIZING_SQL.format(days=days))
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

        # High queue load → scale up or enable multi-cluster
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

        # Low utilization → scale down
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
