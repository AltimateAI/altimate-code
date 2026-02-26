"""Credit consumption analysis — analyze Snowflake credit usage and trends."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry


_CREDIT_USAGE_SQL = """
SELECT
    warehouse_name,
    DATE_TRUNC('day', start_time) as usage_date,
    SUM(credits_used) as credits_used,
    SUM(credits_used_compute) as credits_compute,
    SUM(credits_used_cloud_services) as credits_cloud,
    COUNT(*) as query_count,
    AVG(credits_used) as avg_credits_per_query
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
{warehouse_filter}
GROUP BY warehouse_name, DATE_TRUNC('day', start_time)
ORDER BY usage_date DESC, credits_used DESC
LIMIT {limit}
"""

_CREDIT_SUMMARY_SQL = """
SELECT
    warehouse_name,
    SUM(credits_used) as total_credits,
    SUM(credits_used_compute) as total_compute_credits,
    SUM(credits_used_cloud_services) as total_cloud_credits,
    COUNT(DISTINCT DATE_TRUNC('day', start_time)) as active_days,
    AVG(credits_used) as avg_daily_credits
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
GROUP BY warehouse_name
ORDER BY total_credits DESC
"""

_TOP_EXPENSIVE_SQL = """
SELECT
    query_id,
    LEFT(query_text, 200) as query_preview,
    user_name,
    warehouse_name,
    warehouse_size,
    total_elapsed_time / 1000.0 as execution_time_sec,
    bytes_scanned,
    rows_produced,
    credits_used_cloud_services as credits_used,
    start_time
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE start_time >= DATEADD('day', -{days}, CURRENT_TIMESTAMP())
  AND execution_status = 'SUCCESS'
  AND bytes_scanned > 0
ORDER BY bytes_scanned DESC
LIMIT {limit}
"""


def analyze_credits(
    warehouse: str,
    days: int = 30,
    limit: int = 50,
    warehouse_filter: str | None = None,
) -> dict:
    """Analyze credit consumption for a Snowflake account.

    Returns daily usage breakdown, warehouse summary, and optimization recommendations.
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
            "error": f"Credit analysis is only available for Snowflake warehouses (got {wh_type}).",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)

            # Get daily breakdown
            wh_f = f"AND warehouse_name = '{warehouse_filter}'" if warehouse_filter else ""
            daily_sql = _CREDIT_USAGE_SQL.format(days=days, limit=limit, warehouse_filter=wh_f)
            daily_rows = connector.execute(daily_sql)
            daily = [dict(r) if not isinstance(r, dict) else r for r in daily_rows]

            # Get warehouse summary
            summary_sql = _CREDIT_SUMMARY_SQL.format(days=days)
            summary_rows = connector.execute(summary_sql)
            summary = [dict(r) if not isinstance(r, dict) else r for r in summary_rows]
        finally:
            connector.close()

        # Generate recommendations
        recommendations = _generate_recommendations(summary, daily, days)

        total_credits = sum(s.get("total_credits", 0) or 0 for s in summary)

        return {
            "success": True,
            "daily_usage": daily,
            "warehouse_summary": summary,
            "total_credits": round(total_credits, 4),
            "days_analyzed": days,
            "recommendations": recommendations,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_expensive_queries(
    warehouse: str,
    days: int = 7,
    limit: int = 20,
) -> dict:
    """Find the most expensive queries by bytes scanned."""
    try:
        connector = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {"success": False, "queries": [], "error": f"Connection '{warehouse}' not found."}

    wh_type = "unknown"
    for wh in ConnectionRegistry.list():
        if wh["name"] == warehouse:
            wh_type = wh.get("type", "unknown")
            break

    if wh_type != "snowflake":
        return {
            "success": False,
            "queries": [],
            "error": f"Expensive query analysis is only available for Snowflake (got {wh_type}).",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)
            sql = _TOP_EXPENSIVE_SQL.format(days=days, limit=limit)
            rows = connector.execute(sql)
        finally:
            connector.close()

        queries = [dict(r) if not isinstance(r, dict) else r for r in rows]

        return {
            "success": True,
            "queries": queries,
            "query_count": len(queries),
            "days_analyzed": days,
        }
    except Exception as e:
        return {"success": False, "queries": [], "error": str(e)}


def _generate_recommendations(summary: list[dict], daily: list[dict], days: int) -> list[dict]:
    """Generate cost optimization recommendations."""
    recs = []

    for wh in summary:
        name = wh.get("warehouse_name", "unknown")
        total = wh.get("total_credits", 0) or 0
        active_days = wh.get("active_days", 0) or 0

        # Idle warehouse detection
        if active_days < days * 0.3 and total > 0:
            recs.append({
                "type": "IDLE_WAREHOUSE",
                "warehouse": name,
                "message": f"Warehouse '{name}' was active only {active_days}/{days} days but consumed {total:.2f} credits. Consider auto-suspend or reducing size.",
                "impact": "high",
            })

        # High credit usage
        if total > 100 and days <= 30:
            recs.append({
                "type": "HIGH_USAGE",
                "warehouse": name,
                "message": f"Warehouse '{name}' consumed {total:.2f} credits in {days} days. Review query patterns and consider query optimization.",
                "impact": "high",
            })

    # Check for weekend/off-hours usage
    if not recs:
        recs.append({
            "type": "HEALTHY",
            "message": "No immediate cost optimization issues detected.",
            "impact": "low",
        })

    return recs
