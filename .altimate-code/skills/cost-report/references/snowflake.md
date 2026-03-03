# Snowflake Cost Calculation

## Cost Structure
Snowflake bills three categories: compute (credits), storage ($/TB/month), and cloud services (free up to 10% of daily compute). Compute is the dominant cost for most organizations.

## How to Calculate Query Cost

### Primary Data Source: `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY`
This view retains 365 days of query execution data. Key cost columns:

```sql
SELECT
  query_id,
  query_text,
  user_name,
  warehouse_name,
  warehouse_size,
  execution_time / 1000 AS execution_seconds,
  credits_used_cloud_services,
  -- Compute cost = (execution_time / 3600000) * credits_per_hour_for_warehouse_size
  -- Credits/hour: XS=1, S=2, M=4, L=8, XL=16, 2XL=32, 3XL=64, 4XL=128
  bytes_scanned,
  bytes_spilled_to_local_storage,
  bytes_spilled_to_remote_storage,
  partitions_scanned,
  partitions_total,
  query_type,
  start_time
FROM snowflake.account_usage.query_history
WHERE start_time >= DATEADD('day', -30, CURRENT_TIMESTAMP())
ORDER BY execution_time DESC;
```

### Warehouse-Level Cost: `SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY`
This is the **authoritative source for credit consumption** — it tracks actual credits billed per warehouse per hour.

```sql
SELECT
  warehouse_name,
  SUM(credits_used) AS total_credits,
  SUM(credits_used_compute) AS compute_credits,
  SUM(credits_used_cloud_services) AS cloud_services_credits
FROM snowflake.account_usage.warehouse_metering_history
WHERE start_time >= DATEADD('day', -30, CURRENT_TIMESTAMP())
GROUP BY warehouse_name
ORDER BY total_credits DESC;
```

### Converting Credits to Dollars
Credit price depends on your Snowflake edition and contract:
- Standard: ~$2.00/credit
- Enterprise: ~$3.00/credit
- Business Critical: ~$4.00/credit
- On-demand pricing is higher than pre-purchased capacity

Check `SNOWFLAKE.ORGANIZATION_USAGE.RATE_SHEET_DAILY` for your actual contracted rate.

### Storage Cost: `SNOWFLAKE.ACCOUNT_USAGE.STORAGE_USAGE`

```sql
SELECT
  usage_date,
  storage_bytes / POWER(1024, 4) AS storage_tb,
  stage_bytes / POWER(1024, 4) AS stage_tb,
  failsafe_bytes / POWER(1024, 4) AS failsafe_tb
FROM snowflake.account_usage.storage_usage
WHERE usage_date >= DATEADD('day', -30, CURRENT_DATE())
ORDER BY usage_date DESC;
```

Storage is billed at ~$23/TB/month (on-demand) or ~$40/TB/month (on-demand, Business Critical). Includes active data, Time Travel retention, and Fail-safe (7 days, non-configurable).

## Warehouse Sizing Reference

| Size | Credits/Hour | Use Case |
|------|-------------|----------|
| X-Small | 1 | Development, light queries |
| Small | 2 | Standard analytics |
| Medium | 4 | Medium ETL, BI workloads |
| Large | 8 | Heavy transformations |
| X-Large | 16 | Large data processing |
| 2XL-6XL | 32-256 | Massive workloads |

## Key Cost Signals in Query Profile
- `BYTES_SPILLED_TO_REMOTE_STORAGE > 0` — query needs a larger warehouse (significant perf/cost impact)
- `PARTITIONS_SCANNED / PARTITIONS_TOTAL > 0.5` — poor partition pruning, add filters
- `QUEUING_TIME > 0` — warehouse is undersized for concurrency, consider multi-cluster
- `COMPILATION_TIME > execution_time * 0.3` — overly complex query plan
