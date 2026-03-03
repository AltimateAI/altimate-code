# Agent Modes

altimate-code runs in one of four specialized modes. Each mode has different permissions, tool access, and behavioral guardrails.

## Builder

**Full read/write access. For creating and modifying data pipelines.**

```bash
altimate-code --agent builder
```

Builder mode follows a strict pre-execution protocol for every SQL operation:

1. `sql_analyze` — Check for anti-patterns
2. `sql_predict_cost` — Estimate execution cost
3. `sql_validate` — Verify syntax and schema references
4. `sql_execute` — Run the query
5. `sql_record_feedback` — Store metrics for future cost predictions

### Example: Create a staging model

```
You: Create a staging model for the raw_orders table

Builder: Let me inspect the source table first.

> schema_inspect raw_orders
  Columns: order_id (NUMBER), customer_id (NUMBER), order_date (TIMESTAMP),
           amount (FLOAT), status (VARCHAR), _loaded_at (TIMESTAMP)

> lineage_check "SELECT * FROM raw.raw_orders"
  Lineage: raw.raw_orders → all columns flow through

I'll create a staging model with proper typing, deduplication, and column naming:

> write models/staging/stg_orders.sql
  WITH source AS (
      SELECT * FROM {{ source('raw', 'raw_orders') }}
  ),
  deduplicated AS (
      SELECT *,
          ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY _loaded_at DESC) AS rn
      FROM source
  )
  SELECT
      order_id,
      customer_id,
      order_date,
      amount::DECIMAL(12,2) AS order_amount,
      LOWER(status) AS order_status
  FROM deduplicated
  WHERE rn = 1

> sql_analyze [the above SQL]
  ✓ No anti-patterns detected (confidence: high)

> dbt_run --select stg_orders
  ✓ Compiled and ran successfully
```

### What builder can do

- Create and edit SQL files, dbt models, YAML configs
- Execute SQL (DDL/DML/DQL)
- Run dbt commands
- Generate tests and documentation
- Scaffold new models from templates

---

## Analyst

**Read-only access. Safe for production environments.**

```bash
altimate-code --agent analyst
```

Analyst mode enforces strict guardrails:

- **SELECT only** — INSERT, UPDATE, DELETE, DROP are blocked by SQLGuard
- **Cost-first** — Every query gets a cost prediction before execution
- **LIMIT enforced** — Large scans are automatically limited
- **No file writes** — Cannot modify your codebase

### Example: Investigate expensive queries

```
You: What's driving our Snowflake costs this week?

Analyst: Let me pull the query history and credit analysis.

> finops_analyze_credits prod-snowflake --days 7
  Total credits: 847.2
  Top warehouse: TRANSFORM_WH (523.1 credits, 62%)
  Daily trend: ↑ 15% vs last week

> finops_expensive_queries prod-snowflake --days 7 --limit 5
  1. SELECT * FROM events JOIN users... — 89.3 credits, 47 runs
  2. CREATE TABLE AS SELECT...         — 45.1 credits, 1 run
  3. SELECT COUNT(DISTINCT...)         — 23.7 credits, 312 runs

The #1 cost driver is a query running 47 times that scans the full
events table with a SELECT *. Let me analyze it:

> sql_analyze "SELECT * FROM events JOIN users ON events.user_id = users.id"
  ⚠ SELECT_STAR: Use explicit column list (severity: warning)
  ⚠ MISSING_LIMIT: Add LIMIT for exploratory queries (severity: info)

Recommendations:
1. Replace SELECT * with only the 6 columns actually used downstream
2. Add a date filter — the events table has 2.1B rows but most queries
   only need the last 7 days
3. Consider materializing this as a view with the filter baked in

Estimated savings: ~60 credits/week (71% reduction on this query alone)
```

### What analyst can do

- Run SELECT queries (enforced)
- Inspect schemas and metadata
- Check column-level lineage
- Analyze costs and credit consumption
- Search warehouse metadata
- Detect PII columns

---

## Validator

**Read + validate. For data quality and integrity checks.**

```bash
altimate-code --agent validator
```

### Example: Audit a model before merging

```
You: Validate the changes in models/marts/fct_revenue.sql

Validator:

> sql_analyze [fct_revenue.sql contents]
  ⚠ FUNCTION_IN_FILTER: DATE_TRUNC on order_date prevents index usage
  ✓ No other anti-patterns

> lineage_check [fct_revenue.sql]
  Sources: stg_orders.order_amount, stg_orders.order_date, dim_products.category
  Confidence: high (no SELECT *, schema-qualified, small graph)

> schema_diff [old version] [new version]
  + Added column: revenue_category (VARCHAR)
  ~ Modified column: total_revenue FLOAT → DECIMAL(18,2)
  Severity: medium (type change may affect downstream)

> sql_predict_cost [fct_revenue.sql]
  Tier 2 match: ~12.3 credits per run (medium confidence)
  Previous version: ~11.8 credits — marginal increase

Issues found:
1. FUNCTION_IN_FILTER on line 23 — use a pre-computed date column instead
2. Type change from FLOAT to DECIMAL(18,2) — verify downstream consumers
3. Missing test coverage for the new revenue_category column
```

---

## Migrator

**Cross-warehouse migration specialist.**

```bash
altimate-code --agent migrator
```

### Example: Migrate from Snowflake to BigQuery

```
You: Translate our top 5 models from Snowflake to BigQuery

Migrator:

> sql_translate --source snowflake --target bigquery
  Input:  SELECT DATEADD(day, -7, CURRENT_TIMESTAMP()) AS week_ago,
          IFF(status = 'active', 1, 0) AS is_active,
          TRY_TO_NUMBER(raw_amount) AS amount
          FROM analytics.public.orders
          QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY updated_at DESC) = 1

  Output: SELECT DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) AS week_ago,
          IF(status = 'active', 1, 0) AS is_active,
          SAFE_CAST(raw_amount AS NUMERIC) AS amount
          FROM `analytics.public.orders`
          QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY updated_at DESC) = 1

  Warnings:
  - QUALIFY is supported natively in BigQuery (no change needed)
  - TRY_TO_NUMBER → SAFE_CAST (NULL on failure, same behavior)
  - Table reference backtick-quoted for BigQuery

> lineage_check [source SQL]
> lineage_check [translated SQL]
  ✓ Lineage preserved — same columns, same sources
```

### Supported translation paths

| From | To |
|---|---|
| Snowflake | BigQuery, Databricks, Redshift, PostgreSQL |
| BigQuery | Snowflake, Databricks, Redshift, PostgreSQL |
| Redshift | Snowflake, BigQuery, PostgreSQL |
| PostgreSQL | Snowflake, BigQuery, Databricks |
| MySQL | PostgreSQL, Snowflake |
| SQL Server | PostgreSQL, Snowflake |
