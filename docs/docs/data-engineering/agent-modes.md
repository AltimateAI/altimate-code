# Agent Modes

altimate runs in one of seven specialized modes. Each mode has different permissions, tool access, and behavioral guardrails.

| Mode | Access | Purpose |
|---|---|---|
| **Builder** | Read/Write | Create and modify data pipelines |
| **Analyst** | Read-only | Safe exploration and cost analysis |
| **Validator** | Read + Validate | Data quality and integrity checks |
| **Migrator** | Cross-warehouse | Dialect translation and migration |
| **Researcher** | Read-only + Parallel | Deep multi-step investigations |
| **Trainer** | Read-only + Training | Teach your AI teammate |
| **Executive** | Read-only | Business-friendly reporting (no SQL jargon) |

## Builder

**Full read/write access. For creating and modifying data pipelines.**

```bash
altimate --agent builder
```

Builder mode follows a strict pre-execution protocol for every SQL operation:

1. `sql_analyze` — Check for anti-patterns
2. `sql_validate` — Verify syntax and schema references
3. `sql_execute` — Run the query

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
altimate --agent analyst
```

Analyst mode enforces strict guardrails:

- **SELECT only** — INSERT, UPDATE, DELETE, DROP are blocked by altimate-core
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
altimate --agent validator
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

Issues found:
1. FUNCTION_IN_FILTER on line 23 — use a pre-computed date column instead
2. Type change from FLOAT to DECIMAL(18,2) — verify downstream consumers
3. Missing test coverage for the new revenue_category column
```

---

## Migrator

**Cross-warehouse migration specialist.**

```bash
altimate --agent migrator
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

---

## Researcher

**Read-only + parallel investigation. For complex analytical questions.**

```bash
altimate --agent researcher
```

Researcher mode follows a 4-phase protocol for thorough investigation:

1. **Plan** — Outline questions, data sources, and tool sequence
2. **Gather** — Execute investigation steps, parallelize where possible
3. **Analyze** — Cross-reference findings, identify root causes
4. **Report** — Produce structured report with evidence and recommendations

### Example: Investigate a cost spike

```
You: Why did our Snowflake costs spike last week?

Researcher: Let me plan the investigation.

  Investigation Plan:
  1. Pull credit consumption trends (finops_analyze_credits)
  2. Identify top expensive queries (finops_expensive_queries)
  3. Check for deployment changes (git log)
  4. Correlate query patterns with cost changes

  Proceeding...

> finops_analyze_credits prod-snowflake --days 14
  Last 7 days: 847 credits (↑ 38% vs prior week)
  Top warehouse: TRANSFORM_WH (523 credits, 62%)

> finops_expensive_queries prod-snowflake --days 7
  1. Full table scan on events (89 credits, 47 runs)
  2. New model fct_attribution (45 credits, added 3 days ago)

> bash: git log --oneline --since="7 days ago" -- models/
  abc1234 feat: add fct_attribution model
  def5678 fix: remove partition filter from stg_events

  # Investigation Report

  ## Summary
  Costs increased 38% due to two changes deployed 3 days ago.

  ## Key Findings
  1. fct_attribution model (new) scans 2.1B events rows without partition filter — 45 credits/week
  2. Partition filter was accidentally removed from stg_events in commit def5678 — caused 47 full scans

  ## Recommendations
  1. [ ] Add date partition filter to fct_attribution (estimated savings: 40 credits/week)
  2. [ ] Restore partition filter in stg_events (estimated savings: 60 credits/week)
```

### What researcher can do

- Run all read-only SQL and schema tools
- Use `bash` for git history and code analysis
- Launch parallel sub-investigations with the `task` tool
- Access `websearch` and `webfetch` for external research
- Save discoveries as training for future sessions

### When to use researcher vs analyst

| Use Analyst for... | Use Researcher for... |
|---|---|
| Quick data exploration | Multi-step investigations |
| Single-query answers | Root cause analysis |
| Schema browsing | Cross-referencing multiple data sources |
| Ad-hoc cost checks | Comprehensive audits with reports |

---

## Trainer

**Read-only + training management. For teaching your AI teammate.**

```bash
altimate --agent trainer
```

Trainer mode helps you systematically teach the agent about your project. It cannot modify files — it only reads, explores, and manages training.

### Example: Teach from a correction

```
You: I want you to know that we never use FLOAT for money columns

Trainer: Good rule. Let me save this properly:

  Kind: rule
  Name: no-float-financial
  Content: "Use DECIMAL(18,2) for financial columns (*_amount, *_price, *_cost).
  FLOAT causes rounding errors that compound across aggregations."

  Scope: project (shared with team via git)
  Save this?

You: Yes

Trainer: Saved. Every agent mode will apply this from now on.
  Your teammates get it when they pull.
```

### What trainer can do

- Guide users through teaching interactively
- Read codebase files to understand existing patterns
- Save, list, and remove training entries
- Analyze training gaps and suggest what to teach next
- Review and curate training quality (stale detection, consolidation)

### When to use trainer mode

| Scenario | Why trainer mode |
|---|---|
| New project setup | Teach conventions before anyone starts building |
| New hire onboarding | Walk through what the team has taught |
| Post-incident review | Save lessons learned as permanent rules |
| Loading a style guide | Extract rules and standards from documentation |
| Quarterly audit | Remove stale entries, consolidate, fill gaps |

For the full guide, see [Training: Corrections That Stick](training/index.md).
