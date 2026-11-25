---
title: "dbt Tools — Altimate Code"
description: "Run dbt commands from Altimate Code using the dbt_run tool with full output capture and error reporting."
---

# dbt Tools

## dbt_run

Execute dbt commands from within the agent.

```
> dbt_run --command run --select stg_orders

Running: dbt run --select stg_orders
  ✓ stg_orders .................. [OK in 2.3s]

1 model completed successfully.
```

**Parameters:**
- `command` (optional, default: "run"): dbt command: `run`, `test`, `build`, `compile`, `seed`, `snapshot`
- `select` (optional): Model selection syntax (`stg_orders`, `+fct_revenue`, `tag:daily`)
- `args` (optional): Additional CLI arguments
- `project_dir` (optional): Path to dbt project root

### Examples

```
> dbt_run --command test --select stg_orders
  ✓ not_null_stg_orders_order_id ........ [PASS in 1.1s]
  ✓ unique_stg_orders_order_id .......... [PASS in 0.8s]
  ✓ relationships_stg_orders_customer_id  [PASS in 1.3s]

3 tests passed.
```

```
> dbt_run --command compile --select fct_revenue
  Compiled SQL written to target/compiled/models/marts/fct_revenue.sql
```

```
> dbt_run --command build --select +fct_revenue
  Running upstream models, tests, and fct_revenue...
  ✓ stg_orders ............... [OK in 2.1s]
  ✓ stg_payments ............. [OK in 1.8s]
  ✓ fct_revenue .............. [OK in 3.4s]
  ✓ 5 tests .................. [PASS]
```

---

## dbt_manifest

Parse a dbt manifest.json to understand project structure.

```
> dbt_manifest ./target/manifest.json

Project Summary:
  Models: 47 (12 staging, 8 intermediate, 15 marts, 12 other)
  Sources: 12 (across 3 databases)
  Tests: 89
  Seeds: 3
  Snapshots: 2

Model Dependencies:
  fct_revenue depends on: stg_orders, stg_payments, dim_products
  fct_orders depends on: stg_orders, stg_customers, dim_dates

Source Freshness:
  raw.orders — loaded hourly
  raw.customers — loaded daily
  raw.products — loaded weekly
```

---

## dbt_cost_estimate

Say what a dbt model cost the last times it ran, and what its compiled query would scan before it runs again. Pass `model` (a model name, as dbt's `ref()` takes it) or `sql`. It starts the dbt adapter, so it needs write permission: pass `--allow-write` on `tool run` or the MCP server, and leave plan mode, or a read-only call is refused.

Bytes are not money on most warehouses. Snowflake bills warehouse credits, Databricks bills DBUs for warehouse uptime, and BigQuery capacity (reservations) bills slot time; only BigQuery on-demand bills bytes. So the cost is the warehouse's reported usage for the model's earlier runs (bytes billed, slot time, attributed credits, allocated DBUs) priced at a stated rate, which can be a default or a list price: an estimate, not an invoice amount. The scan figure stays a separate pre-run number.

**Cost (`cost` in the result, first in the text).** The tool finds the model's statements in the last 30 days by dbt's query comment (`"node_id": "<unique_id>"`, matched as exact text), prices each run, and reports the last run, the typical (median) run and the highest, in money and in the warehouse's own unit. Only successful statements that build the model count, newest 500; when a query returns all 500, the answer says only the newest 500 were read. A second query then reads the matching statements that began before the period read (the oldest statement returned, else the 30-day edge) and were not already read. On Snowflake and Databricks it looks for statements that ended within 10 minutes of the cutoff (one day of lookback); a run in the same session that such a statement may belong to is dropped. On BigQuery, which has no session, it looks for a DELETE or UPDATE by the same user created within 60 seconds before the cutoff, or a temporary-relation CTAS by the same user that ended within 10 minutes before it, since either could have joined a later build; such a run is dropped. The answer counts the runs dropped. If that query fails or hits its limit, runs starting within a day of the cutoff are dropped. Snowflake prices each statement at the rate of its UTC date. What a run is depends on the warehouse:

- BigQuery: each build job (create, insert, merge, script) is one run, by the user who ran it. A CREATE TABLE AS SELECT into dbt's temporary relation (a table ending in `__dbt_tmp`) joins the MERGE, INSERT or script by the same user that starts within 10 minutes after it ends, and the two are one run: each such CTAS takes the first qualifying build no other CTAS has taken, since dbt makes one temporary relation per build. A DELETE or UPDATE joins the build job (or that pair) by the same user that starts within a minute after it, else is a run of its own. A script is priced from its child jobs, each by its own reservation, never the script row beside them, and carries the script's user. The child jobs are read from the earliest matched script's creation onward, so they cannot slide out of the 30-day window while the scripts are read; a script whose children may be cut off at the query's limit is unknown.
- Snowflake and Databricks: the statements of one session with gaps of at most 10 minutes. Different sessions are never merged.

| Warehouse | Read from | Cost per statement |
|---|---|---|
| BigQuery | `INFORMATION_SCHEMA.JOBS` of the target's execution project and location (`JOBS_BY_USER` when the role may not list every user's jobs; the answer then says only your own runs were read) | On demand: bytes billed per TiB. In a reservation: slot-hours at a slot-hour rate; the bill follows the reservation, so this is attribution, not the invoice. A job with no bytes billed (BigQuery hides it for tables under a row access policy) is unknown, and its run is left out |
| Snowflake | `snowflake.account_usage.query_history` and `query_attribution_history`, with `organization_usage.usage_in_currency_daily` for the rate (falling back to `rate_sheet_daily`) | Attributed compute credits plus query acceleration credits, each statement at the blended rate its UTC day was billed (contract plus overage; the nearest earlier day when there is no row yet, since the view lags up to three days, and the answer says so). If that view can't be read it falls back to the contract rate sheet, read for the same UTC window, and says overage is not reflected. A day billed in more than one currency leaves its statements unknown. Idle warehouse time is not included; cloud-services credits are reported, not added. A statement under 100 ms is never attributed and counts as zero beside a statement that was; a longer one with no attribution yet makes its run pending, and a run in which no statement was attributed is left out too |
| Databricks | `system.query.history`, `system.billing.usage` and `list_prices` (SQL warehouses only) | The warehouse's billed cost for each hour a statement ran in, split across the statements of that hour by their task time, prorated by overlap for a statement that crosses hours. Hours are UTC instants, whatever the session's time zone. OPTIMIZE and ANALYZE statements that dbt-databricks runs inside the model's materialization are included. List price with published promotions; negotiated discounts are not applied. A matched statement with no task duration of its own is unknown (other statements' missing durations count as zero in an hour's total), and so is one in an hour with no billing row or no task time to share by. Amounts for the last 12 hours may still change as billing lands, and the answer says so |

When cost cannot be known, `cost.unknownReason` says why (when the BigQuery dry run could still be priced, the reason moves into `cost.notes` and `basis` is `dry_run`): no runs in the window, a role without access (Snowflake needs `IMPORTED PRIVILEGES` on the `SNOWFLAKE` database), a `sql` input (it has no history), a model name that matches several nodes, or a Databricks cluster target. Runs left out are counted with the cause of each: a Snowflake run not attributed yet (attribution lands up to 8 hours late) or on a day billed in more than one currency, a Databricks run whose billing has not landed, whose hour has no task time to share by, or with a statement that has no task duration, a BigQuery job with no bytes billed, or a script whose child jobs were not found or may be cut off. The tool never invents a cost when no history was read. A cost it shows is reported usage at a stated rate (`cost.rate`, which can be a default or a list price), not an invoice amount.

**Pre-run scan (unchanged fields).** BigQuery answers from a dry run (`bytes`, `maxBytes`, `lowerBound`); Snowflake and Databricks from the planner's EXPLAIN (`source: "explain"`). Only BigQuery on-demand turns it into money (`cost.selectOnly: { low, high }`). The dry run is an upper bound on bytes (a clustered table can bill less) and each table a query reads bills at least 10 MiB, so with n tables the charge is at least `n x 10 MiB` and at most the dry run's upper bound plus `n x 10 MiB`; the text says "at most $high (at least $low)" only when the table count is certain and no source is involved; the ceiling is rounded up and the floor down so the printed figures still contain the charge, and with history the SELECT line follows the history lines. When the count is unknown (SQL input, no manifest, an ambiguous name) or none was found, one table is assumed, and when a source is involved (it may be a view), the text says "$high, plus 10 MiB (~$0.00006) for each table beyond those counted" instead, and the note states the count used and why. A dry run that is only a lower bound is not priced: a script's dry run covers only its first statement, and a zero estimate is not a size (BigQuery reports 0 for federated and external sources); each gets its own note. n counts physical relations from the manifest: tables, incremental models, snapshots, seeds and sources, with views and ephemeral models resolved to what they read. A source that is a view in BigQuery bills 10 MiB more for each table it reads. The price covers the SELECT only; depending on its strategy, an incremental model can also write a temp table and read the target, which the history shows. If the project is on capacity pricing the dry run is not priced, and neither is it when the pricing mode can't be read (the project's jobs, then your own, show no query job in 7 days or can't be listed).

The pre-run scan runs first and completes before the history queries start (the dbt Python bridge serialises adapter calls); the history has its own 60 s deadline, which only stops the tool waiting: the warehouse may keep running a history query, and the history queries (including the capacity check and the boundary query) are warehouse queries that can incur their own charges. The history never changes the scan figure.

`cost.rate` names the rate and where it came from: `config`, `account` (Snowflake: the billed rate, or the contract rate sheet when that can't be read), `list_price` or `default`. The history queries run through the project's dbt connection.

Set your own rates in the config (see [Configuration](../../configure/config.md)):

```json
{
  "cost": {
    "bigqueryUsdPerTib": 6.25,
    "bigquerySlotHourUsd": 0.06,
    "snowflakeUsdPerCredit": 3.0,
    "databricksUsdPerDbu": 0.55
  }
}
```

A rate you set wins over the account's Snowflake billed or contract rate and the Databricks list price, and Snowflake then makes no rate lookup; without one, the billed rate (then the contract rate) or the list price is used, then the default.

---

## dbt_unit_test_gen

Generate dbt unit tests (v1.8+) from a compiled manifest. Analyzes model SQL for testable logic (CASE/WHEN, JOINs, NULLs, window functions, division, incremental), generates type-correct mock inputs, and assembles complete YAML.

```text
> dbt_unit_test_gen --manifest_path target/manifest.json --model fct_orders --max_scenarios 5

Unit Test Gen: 4 test(s) for fct_orders

=== Unit Test Generation Summary ===
Model: fct_orders
Description: "Daily order totals by order ID"
Materialization: table
Upstream dependencies: 2
Tests generated: 4

=== Upstream Dependencies ===

ref('stg_orders')
  Staged orders from raw source
  Columns:
    order_id (INTEGER) — Primary key for orders
    quantity (INTEGER) — Number of items ordered
    unit_price (NUMERIC) — Price per unit in USD

=== Column Lineage (output ← inputs) ===
  order_total ← stg_orders.quantity, stg_orders.unit_price

=== YAML (paste into schema.yml) ===
unit_tests:
  - name: test_fct_orders_happy_path
    description: Verify correct output for standard input data
    model: fct_orders
    given:
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, quantity: 3, unit_price: 100 }
          - { order_id: 2, quantity: 1, unit_price: 50 }
    expect:
      rows:
        - { order_id: 1, order_total: 300 }
        - { order_id: 2, order_total: 50 }
  # ... null_handling, edge_case, incremental tests
```

**Parameters:**
- `manifest_path` (required): Path to compiled `manifest.json` (run `dbt compile` first)
- `model` (required): Model name or unique_id (e.g. `fct_orders` or `model.project.fct_orders`)
- `dialect` (optional): SQL dialect override (auto-detected from manifest adapter_type)
- `max_scenarios` (optional, default 3): Maximum number of test scenarios to generate

**What it generates:**
- **Scenarios:** `happy_path`, `null_handling` (for CASE/COALESCE), `edge_case` (for JOINs, window functions, division), `incremental` (for incremental models with `input: this` mock)
- **Mock data:** Type-correct values from dialect-aware type mapping (Snowflake, BigQuery, Postgres, Redshift, Databricks, DuckDB, MySQL)
- **Dependencies:** Handles `ref()` for models/seeds/snapshots, `source()` for raw tables, `format: sql` for ephemeral models
- **Context:** Returns model/column descriptions, column lineage, and compiled SQL for the LLM to refine test values

**Skill:** `/dbt-unit-tests` — 5-phase workflow (Analyze → Generate → Refine → Validate → Write) with reference guides for YAML spec, edge-case patterns, and incremental testing.

**Important:** The tool generates scaffold tests with type-correct placeholder values. The LLM skill layer refines expected outputs by running SQL against mock data — always review and verify before committing.

---

## altimate-dbt CLI

`altimate-dbt` is a standalone CLI for dbt workflows. It auto-detects your dbt project directory, Python environment, and adapter type (Snowflake, BigQuery, Databricks, Redshift, etc.).

```bash
# Initialize dbt integration
altimate-dbt init

# Diagnose issues
altimate-dbt doctor

# Run dbt commands
altimate-dbt compile
altimate-dbt build
altimate-dbt run
altimate-dbt test

# Utilities
altimate-dbt execute --query "SELECT 1"    # Run a query via dbt adapter
altimate-dbt columns my_model      # List model columns
altimate-dbt graph                 # View lineage/DAG
altimate-dbt deps                  # Manage dependencies
```

All commands provide friendly error diagnostics with actionable fix suggestions when something goes wrong.

> **Tip:** In builder mode, the agent prefers `altimate-dbt` over the raw `dbt_run` tool for better error handling and auto-detection.

---

## dbt Skills

### /dbt-unit-tests

Automated dbt unit test generation (v1.8+). Uses `dbt_unit_test_gen` to produce scaffold YAML, then refines expected outputs by reading the compiled SQL and running it against the mock data.

```text
You: /dbt-unit-tests fct_orders

> dbt_unit_test_gen --manifest_path target/manifest.json --model fct_orders
> altimate-dbt test --select fct_orders

Generated 4 unit tests for fct_orders:
  ✓ test_fct_orders_happy_path
  ✓ test_fct_orders_null_handling
  ✓ test_fct_orders_edge_case_1 (division)
  ✓ test_fct_orders_incremental

All tests passing. YAML written to models/marts/_unit_tests.yml.
```

Workflow: Analyze → Generate → Refine → Validate → Write. See [reference guides](https://github.com/AltimateAI/altimate-code/tree/main/.opencode/skills/dbt-unit-tests/references) for edge-case patterns and incremental testing.

### /generate-tests

Auto-generate dbt test definitions from table metadata.

```
You: /generate-tests models/staging/stg_orders.sql

> schema_inspect stg_orders
> lineage_check [stg_orders SQL]

Generated tests for schema.yml:

models:
  - name: stg_orders
    columns:
      - name: order_id
        tests:
          - not_null
          - unique
      - name: customer_id
        tests:
          - not_null
          - relationships:
              to: ref('stg_customers')
              field: customer_id
      - name: order_amount
        tests:
          - not_null
          - dbt_utils.accepted_range:
              min_value: 0
      - name: order_status
        tests:
          - accepted_values:
              values: ['pending', 'shipped', 'delivered', 'cancelled']
```

### /model-scaffold

Scaffold dbt models following medallion architecture.

```
You: /model-scaffold orders from raw.raw_orders

Generated files:

models/staging/stg_orders.sql
models/staging/stg_orders.yml
models/intermediate/int_orders_enriched.sql
models/marts/fct_orders.sql
models/marts/fct_orders.yml
```

### /yaml-config

Generate sources.yml from warehouse schema.

```
You: /yaml-config for raw schema tables

> schema_search --schema RAW

Generated models/staging/sources.yml:

sources:
  - name: raw
    database: ANALYTICS
    schema: RAW
    tables:
      - name: raw_orders
        loaded_at_field: _loaded_at
        freshness:
          warn_after: {count: 12, period: hour}
          error_after: {count: 24, period: hour}
      - name: raw_customers
        loaded_at_field: _loaded_at
      - name: raw_products
```

### /dbt-docs

Generate model and column descriptions.

```
You: /dbt-docs models/marts/fct_revenue.sql

> lineage_check [fct_revenue SQL]
> schema_inspect [source tables]

Generated description:

models:
  - name: fct_revenue
    description: >
      Monthly revenue fact table aggregating order amounts by product category.
      Grain: one row per product category per month.
      Sources: stg_orders, dim_products
    columns:
      - name: revenue_month
        description: "First day of the month (truncated from order_date)"
      - name: product_category
        description: "Product category from dim_products"
      - name: total_revenue
        description: "Sum of order_amount for the category/month"
      - name: order_count
        description: "Count of distinct orders"
```

### /incremental-logic

Generate incremental materialization strategies.

```
You: /incremental-logic for fct_orders

Recommended strategy: merge (upsert)

{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    on_schema_change='append_new_columns'
) }}

SELECT
    order_id,
    customer_id,
    order_amount,
    order_status,
    updated_at
FROM {{ ref('stg_orders') }}

{% if is_incremental() %}
WHERE updated_at > (SELECT MAX(updated_at) FROM {{ this }})
{% endif %}
```

---

## Completion-gate validators

Beyond the agent-facing tools above, altimate-code ships **harness-side
validators** that fire automatically after the agent declares done. They run
`altimate-dbt test` and `altimate-dbt schema-verify` against every model
modified during the session and block "done" if anything failed.

This is **opt-in** today via either `ALTIMATE_VALIDATORS_ENABLED=1`
(enforcement mode — failing validators block "done" with synthetic
retries) or `ALTIMATE_VALIDATORS_SHADOW=1` (telemetry-only mode — runs
without blocking, useful for measuring "would have caught" rates). When
neither flag is set the dispatch path is completely skipped and there
is zero overhead. See the [Validators page](../validators.md) for the
full reference, env var catalogue, performance characteristics, and
the phased rollout plan.
