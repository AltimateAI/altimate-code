# BigQuery Cost Calculation

## Cost Structure
BigQuery has two pricing models: on-demand (per TB scanned) and capacity (slot-hours). Storage is billed separately by both models.

## How to Calculate Query Cost

### Primary Data Source: `INFORMATION_SCHEMA.JOBS`
Available per-project and per-organization. Retains 180 days of query metadata.

```sql
-- Per-project: region-specific
SELECT
  job_id,
  user_email,
  query,
  total_bytes_processed,
  total_bytes_billed,
  total_slot_ms,
  creation_time,
  end_time,
  TIMESTAMP_DIFF(end_time, start_time, SECOND) AS duration_seconds,
  -- On-demand cost estimate:
  (total_bytes_billed / POW(1024, 4)) * 6.25 AS estimated_cost_usd,
  cache_hit,
  statement_type
FROM `region-us`.INFORMATION_SCHEMA.JOBS
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND job_type = 'QUERY'
  AND state = 'DONE'
ORDER BY total_bytes_billed DESC;
```

### Organization-Wide View
```sql
-- Cross-project cost view (requires org-level access)
SELECT
  project_id,
  user_email,
  SUM(total_bytes_billed) / POW(1024, 4) AS total_tb_billed,
  SUM(total_bytes_billed) / POW(1024, 4) * 6.25 AS estimated_cost_usd,
  COUNT(*) AS query_count
FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_ORGANIZATION
WHERE creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND job_type = 'QUERY'
GROUP BY project_id, user_email
ORDER BY estimated_cost_usd DESC;
```

### On-Demand Pricing
- **$6.25 per TB** of data scanned (first 1 TB/month free per billing account)
- `total_bytes_billed` is the billable amount (rounded up to minimum 10 MB per query)
- `cache_hit = true` means zero bytes billed (free)
- Queries against `INFORMATION_SCHEMA` are free

### Capacity Pricing (Editions)
- Standard: $0.04/slot-hour
- Enterprise: $0.06/slot-hour
- Enterprise Plus: $0.10/slot-hour
- Cost = `total_slot_ms / 3,600,000 * slot_price_per_hour`

### Storage Cost
```sql
SELECT
  table_schema,
  table_name,
  total_rows,
  total_logical_bytes / POW(1024, 3) AS size_gb,
  -- Active: $0.02/GB/month, Long-term (90+ days): $0.01/GB/month
  (total_logical_bytes / POW(1024, 3)) * 0.02 AS monthly_storage_cost_usd
FROM `project`.`dataset`.INFORMATION_SCHEMA.TABLE_STORAGE
ORDER BY total_logical_bytes DESC;
```

## Key Cost Signals
- `total_bytes_billed >> total_bytes_processed` — minimum billing rounding (10 MB floor per query)
- `cache_hit = false` on repeated identical queries — non-deterministic functions prevent caching
- `total_slot_ms` very high relative to bytes — query is compute-bound, not I/O-bound
- `bi_engine_statistics.bi_engine_mode = 'DISABLED'` — BI Engine not accelerating eligible queries
