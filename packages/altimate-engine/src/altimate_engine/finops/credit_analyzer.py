"""Credit consumption analysis — analyze warehouse credit usage and trends."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry


# ---------------------------------------------------------------------------
# Snowflake SQL templates
# ---------------------------------------------------------------------------

_SNOWFLAKE_CREDIT_USAGE_SQL = """
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

_SNOWFLAKE_CREDIT_SUMMARY_SQL = """
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

_SNOWFLAKE_EXPENSIVE_SQL = """
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

# ---------------------------------------------------------------------------
# BigQuery SQL templates
# ---------------------------------------------------------------------------

_BIGQUERY_CREDIT_USAGE_SQL = """
SELECT
    '' as warehouse_name,
    DATE(creation_time) as usage_date,
    SUM(total_bytes_billed) / 1099511627776.0 * 5.0 as credits_used,
    SUM(total_bytes_billed) / 1099511627776.0 * 5.0 as credits_compute,
    0 as credits_cloud,
    COUNT(*) as query_count,
    AVG(total_bytes_billed) / 1099511627776.0 * 5.0 as avg_credits_per_query
FROM `region-{location}.INFORMATION_SCHEMA.JOBS`
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
GROUP BY DATE(creation_time)
ORDER BY usage_date DESC
LIMIT {limit}
"""

_BIGQUERY_CREDIT_SUMMARY_SQL = """
SELECT
    '' as warehouse_name,
    SUM(total_bytes_billed) / 1099511627776.0 * 5.0 as total_credits,
    SUM(total_bytes_billed) / 1099511627776.0 * 5.0 as total_compute_credits,
    0 as total_cloud_credits,
    COUNT(DISTINCT DATE(creation_time)) as active_days,
    AVG(total_bytes_billed) / 1099511627776.0 * 5.0 as avg_daily_credits
FROM `region-{location}.INFORMATION_SCHEMA.JOBS`
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
"""

_BIGQUERY_EXPENSIVE_SQL = """
SELECT
    job_id as query_id,
    LEFT(query, 200) as query_preview,
    user_email as user_name,
    '' as warehouse_name,
    reservation_id as warehouse_size,
    TIMESTAMP_DIFF(end_time, start_time, SECOND) as execution_time_sec,
    total_bytes_billed as bytes_scanned,
    0 as rows_produced,
    total_bytes_billed / 1099511627776.0 * 5.0 as credits_used,
    start_time
FROM `region-{location}.INFORMATION_SCHEMA.JOBS`
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL {days} DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
  AND total_bytes_billed > 0
ORDER BY total_bytes_billed DESC
LIMIT {limit}
"""

# ---------------------------------------------------------------------------
# Databricks SQL templates
# ---------------------------------------------------------------------------

_DATABRICKS_CREDIT_USAGE_SQL = """
SELECT
    usage_metadata.warehouse_id as warehouse_name,
    usage_date,
    SUM(usage_quantity) as credits_used,
    SUM(usage_quantity) as credits_compute,
    0 as credits_cloud,
    0 as query_count,
    AVG(usage_quantity) as avg_credits_per_query
FROM system.billing.usage
WHERE usage_date >= DATE_SUB(CURRENT_DATE(), {days})
  AND billing_origin_product = 'SQL'
GROUP BY usage_metadata.warehouse_id, usage_date
ORDER BY usage_date DESC
LIMIT {limit}
"""

_DATABRICKS_CREDIT_SUMMARY_SQL = """
SELECT
    usage_metadata.warehouse_id as warehouse_name,
    SUM(usage_quantity) as total_credits,
    SUM(usage_quantity) as total_compute_credits,
    0 as total_cloud_credits,
    COUNT(DISTINCT usage_date) as active_days,
    AVG(usage_quantity) as avg_daily_credits
FROM system.billing.usage
WHERE usage_date >= DATE_SUB(CURRENT_DATE(), {days})
  AND billing_origin_product = 'SQL'
GROUP BY usage_metadata.warehouse_id
ORDER BY total_credits DESC
"""

_DATABRICKS_EXPENSIVE_SQL = """
SELECT
    query_id,
    LEFT(query_text, 200) as query_preview,
    user_name,
    warehouse_id as warehouse_name,
    '' as warehouse_size,
    total_duration_ms / 1000.0 as execution_time_sec,
    read_bytes as bytes_scanned,
    rows_produced,
    0 as credits_used,
    start_time
FROM system.query.history
WHERE start_time >= DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL '{days}' DAY)
  AND status = 'FINISHED'
  AND read_bytes > 0
ORDER BY read_bytes DESC
LIMIT {limit}
"""


def _get_wh_type(warehouse: str) -> str:
    for wh in ConnectionRegistry.list():
        if wh["name"] == warehouse:
            return wh.get("type", "unknown")
    return "unknown"


def _build_credit_usage_sql(wh_type: str, days: int, limit: int, warehouse_filter: str | None) -> str | None:
    if wh_type == "snowflake":
        wh_f = f"AND warehouse_name = '{warehouse_filter}'" if warehouse_filter else ""
        return _SNOWFLAKE_CREDIT_USAGE_SQL.format(days=days, limit=limit, warehouse_filter=wh_f)
    elif wh_type == "bigquery":
        return _BIGQUERY_CREDIT_USAGE_SQL.format(days=days, limit=limit, location="US")
    elif wh_type == "databricks":
        return _DATABRICKS_CREDIT_USAGE_SQL.format(days=days, limit=limit)
    return None


def _build_credit_summary_sql(wh_type: str, days: int) -> str | None:
    if wh_type == "snowflake":
        return _SNOWFLAKE_CREDIT_SUMMARY_SQL.format(days=days)
    elif wh_type == "bigquery":
        return _BIGQUERY_CREDIT_SUMMARY_SQL.format(days=days, location="US")
    elif wh_type == "databricks":
        return _DATABRICKS_CREDIT_SUMMARY_SQL.format(days=days)
    return None


def _build_expensive_sql(wh_type: str, days: int, limit: int) -> str | None:
    if wh_type == "snowflake":
        return _SNOWFLAKE_EXPENSIVE_SQL.format(days=days, limit=limit)
    elif wh_type == "bigquery":
        return _BIGQUERY_EXPENSIVE_SQL.format(days=days, limit=limit, location="US")
    elif wh_type == "databricks":
        return _DATABRICKS_EXPENSIVE_SQL.format(days=days, limit=limit)
    return None


def analyze_credits(
    warehouse: str,
    days: int = 30,
    limit: int = 50,
    warehouse_filter: str | None = None,
) -> dict:
    """Analyze credit consumption for a warehouse account.

    Returns daily usage breakdown, warehouse summary, and optimization recommendations.
    """
    try:
        connector = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {"success": False, "error": f"Connection '{warehouse}' not found."}

    wh_type = _get_wh_type(warehouse)

    daily_sql = _build_credit_usage_sql(wh_type, days, limit, warehouse_filter)
    summary_sql = _build_credit_summary_sql(wh_type, days)

    if daily_sql is None or summary_sql is None:
        return {
            "success": False,
            "error": f"Credit analysis is not available for {wh_type} warehouses.",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)

            daily_rows = connector.execute(daily_sql)
            daily = [dict(r) if not isinstance(r, dict) else r for r in daily_rows]

            summary_rows = connector.execute(summary_sql)
            summary = [dict(r) if not isinstance(r, dict) else r for r in summary_rows]
        finally:
            connector.close()

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

    wh_type = _get_wh_type(warehouse)

    sql = _build_expensive_sql(wh_type, days, limit)
    if sql is None:
        return {
            "success": False,
            "queries": [],
            "error": f"Expensive query analysis is not available for {wh_type} warehouses.",
        }

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)
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
