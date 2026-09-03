# Cost Governance Patterns

## Resource Monitor Architecture

Resource monitors work at two levels — account and warehouse. Set both: the account-level monitor is a hard ceiling; warehouse-level monitors catch runaway workloads per team before they drain the account budget.

```
Account monthly monitor (e.g. 500 credits)
  └─ TRANSFORM_WH monitor  (e.g. 200 credits)
  └─ ANALYTICS_WH monitor  (e.g. 150 credits)
  └─ LOADING_WH monitor    (e.g. 50 credits)
```

## Trigger Thresholds

| Trigger | Action | When to use |
|---------|--------|-------------|
| 50% | NOTIFY | Early warning, useful for short-cycle periods (weekly) |
| 75% | NOTIFY | Standard early warning |
| 90% | NOTIFY | Critical warning — review before hitting limit |
| 100% | SUSPEND | Prevent further spend; alert immediately |

`SUSPEND` stops the warehouse from starting new queries. In-flight queries complete. `SUSPEND_IMMEDIATE` kills in-flight queries too — use only as a last resort.

## Credit Budget Sizing (Starting Points)

These are starting points for a team of ~5 data engineers with a modest data volume. Adjust based on query complexity and data size.

| Warehouse | Monthly credits (start) | Scale trigger |
|-----------|------------------------|---------------|
| LOADING_WH | 10–25 | Loader runs > 4 hours/day |
| TRANSFORM_WH | 50–150 | dbt build > 2 hours/day |
| ANALYTICS_WH | 75–200 | > 20 concurrent analyst sessions |
| DEV_WH | 20–50 | Dev team > 5 engineers |
| Account total | 2× sum of above | Catch untagged/unmonitored use |

1 Snowflake credit ≈ $2–$4 USD depending on your contract (on-demand is higher).

## Object Tagging for Cost Allocation

A consistent tag taxonomy makes cost attribution easy in SNOWFLAKE.ACCOUNT_USAGE.

### Recommended tag taxonomy

```sql
-- Core tags
CREATE TAG <db>.<schema>.cost_center
  ALLOWED_VALUES 'engineering', 'marketing', 'finance', 'data-platform', 'ml';
CREATE TAG <db>.<schema>.team
  ALLOWED_VALUES 'data-platform', 'analytics', 'ml-engineering', 'bi';
CREATE TAG <db>.<schema>.environment
  ALLOWED_VALUES 'prod', 'staging', 'dev', 'sandbox';
CREATE TAG <db>.<schema>.project
  COMMENT = 'Project or initiative name (free text)';
```

### Apply tags

```sql
-- Warehouses
ALTER WAREHOUSE TRANSFORM_WH  SET TAG cost_center = 'data-platform', environment = 'prod';
ALTER WAREHOUSE ANALYTICS_WH  SET TAG cost_center = 'analytics', environment = 'prod';

-- Databases
ALTER DATABASE RAW       SET TAG environment = 'prod';
ALTER DATABASE TRANSFORM SET TAG environment = 'prod';

-- Schemas (inherit from database, but can override)
ALTER SCHEMA ANALYTICS.FINANCE SET TAG cost_center = 'finance';
```

### Query cost by tag

```sql
-- Cost per team (last 30 days)
SELECT
  tag_value AS team,
  SUM(credits_used) AS total_credits,
  SUM(credits_used) * 3.0 AS estimated_cost_usd   -- adjust multiplier to your rate
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY wh
JOIN SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES tr
  ON tr.object_name = wh.warehouse_name
  AND tr.tag_name = 'TEAM'
  AND tr.domain = 'WAREHOUSE'
WHERE wh.start_time >= DATEADD('day', -30, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY 2 DESC;
```

## Detecting Cost Anomalies

### Daily credit spike detection

```sql
SELECT
  DATE_TRUNC('hour', start_time) AS hour,
  warehouse_name,
  SUM(credits_used) AS credits,
  LAG(SUM(credits_used)) OVER (PARTITION BY warehouse_name ORDER BY DATE_TRUNC('hour', start_time)) AS prev_hour,
  SUM(credits_used) / NULLIF(LAG(SUM(credits_used)) OVER (
    PARTITION BY warehouse_name ORDER BY DATE_TRUNC('hour', start_time)), 0) AS ratio
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
WHERE start_time >= DATEADD('day', -7, CURRENT_TIMESTAMP())
GROUP BY 1, 2
HAVING ratio > 3   -- flag any hour that's 3× the prior hour
ORDER BY 4 DESC;
```

### Runaway query detection

```sql
SELECT
  query_id, user_name, warehouse_name,
  query_text,
  credits_used_cloud_services,
  ROUND(total_elapsed_time / 1000 / 60, 1) AS duration_minutes,
  bytes_scanned / 1e9 AS gb_scanned
FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
WHERE start_time >= DATEADD('day', -1, CURRENT_TIMESTAMP())
  AND (credits_used_cloud_services > 1 OR total_elapsed_time > 1800000)  -- > 1 credit or > 30min
ORDER BY credits_used_cloud_services DESC
LIMIT 20;
```

## Snowflake Storage Cost Management

Storage is cheap ($23/TB/month compressed) but Fail-Safe and Time Travel add up on large tables.

```sql
-- Find tables with long Time Travel windows (default 1 day, can be 0–90)
SELECT table_schema, table_name, data_retention_time_in_days, bytes / 1e9 AS size_gb
FROM INFORMATION_SCHEMA.TABLES
WHERE data_retention_time_in_days > 1
ORDER BY bytes DESC;

-- Reduce Time Travel for staging/raw tables (not needed for recovery)
ALTER TABLE RAW.SALESFORCE.accounts SET DATA_RETENTION_TIME_IN_DAYS = 0;

-- Find tables not queried in 30+ days (candidates for archival)
-- Use finops_unused_resources tool for this — it wraps QUERY_HISTORY analysis
```
