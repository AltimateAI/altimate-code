---
title: "ClickHouse Guide — Altimate Code"
description: "First-class ClickHouse support in Altimate Code. Add a ClickHouse warehouse and start running SQL analysis in minutes."
---

# ClickHouse Guide

Altimate Code has first-class ClickHouse support — connect to self-hosted clusters, ClickHouse Cloud, or local Docker instances and use the full suite of SQL analysis, schema inspection, and optimization tools.

## Quick Start

### 1. Connect

```bash
# Add a local ClickHouse
> warehouse_add my-clickhouse {"type": "clickhouse", "host": "localhost", "port": 8123, "database": "analytics"}

# Or ClickHouse Cloud
> warehouse_add ch-cloud {"type": "clickhouse", "host": "abc.clickhouse.cloud", "port": 8443, "protocol": "https", "user": "default", "password": "..."}
```

### 2. Verify

```bash
> warehouse_test my-clickhouse
✓ Connected successfully
```

### 3. Explore

```bash
> "Show me all tables in my ClickHouse analytics database"
> "Describe the events table schema"
```

## What Can Altimate Code Do for ClickHouse Users?

### Analyze Query Performance

ClickHouse queries can be deceptively fast — until they scan terabytes. Altimate Code can analyze your queries and spot issues.

```
> "Analyze this query for performance issues"

SELECT user_id, count()
FROM events
WHERE toDate(timestamp) = today()
GROUP BY user_id
ORDER BY count() DESC

# Altimate Code spots:
# ⚠ toDate(timestamp) prevents partition pruning — use timestamp >= toStartOfDay(now())
# ⚠ No LIMIT clause — consider adding LIMIT for large result sets
# ✓ GROUP BY + ORDER BY is efficient with MergeTree
```

### Optimize MergeTree Table Design

The choice of `ORDER BY` key, partitioning, and engine variant dramatically affects ClickHouse performance. Altimate Code understands these nuances.

```
> "Review my table design for the events table"

# Altimate Code analyzes:
# - ORDER BY key alignment with common query patterns
# - Partition granularity (too fine = too many parts, too coarse = slow scans)
# - Column types (String vs LowCardinality, DateTime vs DateTime64)
# - Engine choice (MergeTree vs ReplacingMergeTree vs AggregatingMergeTree)
```

### Translate SQL Across Dialects

Moving from PostgreSQL, BigQuery, or Snowflake to ClickHouse? Altimate Code translates SQL between dialects.

```
> "Translate this Snowflake query to ClickHouse"

-- Snowflake
SELECT
  DATE_TRUNC('month', created_at) AS month,
  APPROX_COUNT_DISTINCT(user_id) AS unique_users
FROM events
WHERE created_at >= DATEADD('month', -6, CURRENT_TIMESTAMP())
GROUP BY 1

-- ClickHouse (translated)
SELECT
  toStartOfMonth(created_at) AS month,
  uniqHLL12(user_id) AS unique_users
FROM events
WHERE created_at >= subtractMonths(now(), 6)
GROUP BY month
ORDER BY month
```

### Inspect Schema & Lineage

```
> "What are the columns in the events table?"
> "Show me column-level lineage for the daily_metrics materialized view"
> "Which tables reference the users table?"
```

### Monitor Cluster Health via system Tables

ClickHouse exposes rich operational data in `system.*` tables. Altimate Code can query them for you.

```
> "Show me the top 10 slowest queries in the last hour"
> "How many parts does the events table have? Is it healthy?"
> "What's the current merge activity?"
> "Show disk usage by table"
```

### Write and Debug ClickHouse SQL

ClickHouse SQL has unique features — `arrayJoin`, `WITH FILL`, window functions over `ORDER BY` tuples, `PREWHERE`, and more. Altimate Code understands them natively.

```
> "Write a query that uses arrayJoin to explode the tags array in the events table and count occurrences"

SELECT
  tag,
  count() AS cnt
FROM events
ARRAY JOIN tags AS tag
GROUP BY tag
ORDER BY cnt DESC
LIMIT 20
```

### dbt + ClickHouse

If you use dbt with the [dbt-clickhouse adapter](https://github.com/ClickHouse/dbt-clickhouse), Altimate Code detects your dbt project and ClickHouse profile automatically.

```
> /discover

## dbt Project
✓ Project "analytics" (profile: clickhouse_prod)

## Warehouse Connections
### From dbt profiles.yml
Name              | Type       | Source
dbt_clickhouse    | clickhouse | dbt-profile
```

All dbt skills work with ClickHouse:

- `/dbt-develop` — develop new models with ClickHouse-aware SQL
- `/dbt-troubleshoot` — debug dbt run failures
- `/dbt-analyze` — analyze model performance

### Materialized View Pipelines

ClickHouse materialized views are real-time transformation pipelines. Altimate Code helps design and debug them.

```
> "Help me create a materialized view that aggregates events into hourly metrics"

CREATE TABLE analytics.hourly_metrics (
  hour DateTime,
  event_type LowCardinality(String),
  total UInt64,
  unique_users AggregateFunction(uniq, UInt64)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, event_type);

CREATE MATERIALIZED VIEW analytics.hourly_metrics_mv
TO analytics.hourly_metrics AS
SELECT
  toStartOfHour(timestamp) AS hour,
  event_type,
  count() AS total,
  uniqState(user_id) AS unique_users
FROM analytics.events
GROUP BY hour, event_type;
```

## ClickHouse-Specific Tips

### LowCardinality for Repeated Strings

```
> "Which String columns in my events table should use LowCardinality?"

# Altimate Code checks cardinality:
# ✓ event_type — 47 distinct values → use LowCardinality(String)
# ✓ country — 195 distinct values → use LowCardinality(String)
# ✗ user_agent — 12M distinct values → keep as String
```

### Partition Pruning

```
> "Is my events query using partition pruning?"

# Altimate Code checks EXPLAIN output and warns if:
# - WHERE clause doesn't match partition key
# - Date functions prevent pruning (e.g., toDate(ts) vs ts >= ...)
```

### Codec Selection

```
> "Suggest compression codecs for my events table columns"

# Altimate Code recommends based on data patterns:
# timestamp — Delta + ZSTD (monotonic timestamps)
# user_id — ZSTD (random integers)
# event_type — LowCardinality is better than codec here
# payload — ZSTD(3) (JSON strings, higher ratio)
```

## Version Compatibility

Altimate Code supports all non-EOL ClickHouse server versions:

| Version | Type | Status |
|---------|------|--------|
| 25.x | Stable | Supported |
| 24.8 | LTS | Supported |
| 24.3 | LTS | Supported |
| 23.8 | LTS | Supported |
| < 23.3 | EOL | Not tested |

The driver uses the official `@clickhouse/client` package which communicates over HTTP(S), ensuring compatibility across versions and deployment models (self-hosted, ClickHouse Cloud, Altinity.Cloud).

## Auto-Discovery

Altimate Code automatically detects ClickHouse from:

| Source | Detection |
|--------|-----------|
| **dbt profiles** | `type: clickhouse` in `~/.dbt/profiles.yml` |
| **Docker containers** | Running `clickhouse/clickhouse-server` images |
| **Environment variables** | `CLICKHOUSE_HOST` or `CLICKHOUSE_URL` |
