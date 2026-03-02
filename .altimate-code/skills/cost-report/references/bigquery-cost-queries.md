# BigQuery Cost Queries

Use `sql_execute` to run these queries against the connected BigQuery warehouse. Adjust the region and date range as needed.

## Top Expensive Queries (by bytes billed)

```sql
SELECT
    job_id,
    query,
    user_email,
    total_bytes_billed,
    total_slot_ms,
    ROUND(total_bytes_billed / POW(1024, 4), 4) AS estimated_tb_billed,
    ROUND((total_bytes_billed / POW(1024, 4)) * 6.25, 4) AS estimated_cost_usd,
    statement_type,
    creation_time,
    end_time,
    TIMESTAMP_DIFF(end_time, creation_time, SECOND) AS duration_seconds
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
  AND state = 'DONE'
  AND error_result IS NULL
  AND statement_type != 'SCRIPT'
  AND total_bytes_billed > 0
ORDER BY total_bytes_billed DESC
LIMIT @limit
```

Replace `@days` with the number of days (default 30) and `@limit` with the query count (default 20). Change `region-us` to match the dataset region.

## Cost by User

```sql
SELECT
    user_email,
    COUNT(*) AS query_count,
    SUM(total_bytes_billed) AS total_bytes_billed,
    ROUND(SUM(total_bytes_billed) / POW(1024, 4) * 6.25, 2) AS total_cost_usd,
    ROUND(AVG(total_bytes_billed) / POW(1024, 4) * 6.25, 4) AS avg_cost_per_query_usd
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
  AND state = 'DONE'
  AND error_result IS NULL
  AND total_bytes_billed > 0
GROUP BY user_email
ORDER BY total_bytes_billed DESC
```

## Cost by Dataset

```sql
SELECT
    referenced_table.dataset_id AS dataset,
    COUNT(DISTINCT job_id) AS query_count,
    SUM(total_bytes_billed) AS total_bytes_billed,
    ROUND(SUM(total_bytes_billed) / POW(1024, 4) * 6.25, 2) AS total_cost_usd
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT,
UNNEST(referenced_tables) AS referenced_table
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
  AND state = 'DONE'
  AND error_result IS NULL
GROUP BY dataset
ORDER BY total_bytes_billed DESC
```

## Slot Utilization

```sql
SELECT
    TIMESTAMP_TRUNC(period_start, HOUR) AS hour,
    SUM(period_slot_ms) / 3600000 AS avg_slots_used
FROM `region-us`.INFORMATION_SCHEMA.JOBS_TIMELINE_BY_PROJECT
WHERE period_start >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
GROUP BY hour
ORDER BY hour DESC
```

## Cost Thresholds

| Tier | Bytes Billed | Est. Cost (on-demand) | Label |
|------|-------------|----------------------|-------|
| 1 | < 1 GB | < $0.006 | Cheap |
| 2 | 1 GB – 100 GB | $0.006 – $0.625 | Moderate |
| 3 | 100 GB – 10 TB | $0.625 – $62.50 | Expensive |
| 4 | > 10 TB | > $62.50 | Dangerous |

On-demand pricing: $6.25/TB. Flat-rate/editions pricing varies by commitment.
