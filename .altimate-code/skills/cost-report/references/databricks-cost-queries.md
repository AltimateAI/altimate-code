# Databricks Cost Queries

Use `sql_execute` to run these queries against the connected Databricks warehouse. Requires access to the `system` catalog.

## Top Expensive Queries (by read bytes)

```sql
SELECT
    statement_id,
    statement_text,
    executed_by,
    read_bytes,
    ROUND(read_bytes / POW(1024, 3), 2) AS read_gb,
    total_duration_ms,
    ROUND(total_duration_ms / 1000.0, 1) AS duration_seconds,
    warehouse_id,
    compute_resources_dbus AS dbus_consumed,
    status,
    start_time,
    end_time
FROM system.query.history
WHERE start_time >= DATEADD(DAY, -@days, CURRENT_TIMESTAMP())
  AND status = 'FINISHED'
  AND read_bytes > 0
ORDER BY read_bytes DESC
LIMIT @limit
```

Replace `@days` with the number of days (default 30) and `@limit` with the query count (default 20).

## Cost by User

```sql
SELECT
    executed_by,
    COUNT(*) AS query_count,
    SUM(read_bytes) AS total_read_bytes,
    ROUND(SUM(read_bytes) / POW(1024, 3), 2) AS total_read_gb,
    SUM(compute_resources_dbus) AS total_dbus,
    ROUND(AVG(total_duration_ms) / 1000.0, 1) AS avg_duration_seconds
FROM system.query.history
WHERE start_time >= DATEADD(DAY, -@days, CURRENT_TIMESTAMP())
  AND status = 'FINISHED'
GROUP BY executed_by
ORDER BY total_read_bytes DESC
```

## Cost by Warehouse

```sql
SELECT
    warehouse_id,
    COUNT(*) AS query_count,
    SUM(read_bytes) AS total_read_bytes,
    ROUND(SUM(read_bytes) / POW(1024, 3), 2) AS total_read_gb,
    SUM(compute_resources_dbus) AS total_dbus,
    ROUND(AVG(total_duration_ms) / 1000.0, 1) AS avg_duration_seconds
FROM system.query.history
WHERE start_time >= DATEADD(DAY, -@days, CURRENT_TIMESTAMP())
  AND status = 'FINISHED'
GROUP BY warehouse_id
ORDER BY total_read_bytes DESC
```

## DBU Usage Over Time

```sql
SELECT
    DATE_TRUNC('DAY', start_time) AS day,
    SUM(compute_resources_dbus) AS total_dbus,
    COUNT(*) AS query_count
FROM system.query.history
WHERE start_time >= DATEADD(DAY, -@days, CURRENT_TIMESTAMP())
  AND status = 'FINISHED'
GROUP BY day
ORDER BY day DESC
```

## Cost Thresholds

| Tier | DBUs | Label |
|------|------|-------|
| 1 | < 0.1 | Cheap |
| 2 | 0.1 – 10 | Moderate |
| 3 | 10 – 100 | Expensive |
| 4 | > 100 | Dangerous |

Actual cost depends on DBU pricing for your workspace tier (Standard, Premium, Enterprise) and compute type (SQL Serverless, Pro, Classic).
