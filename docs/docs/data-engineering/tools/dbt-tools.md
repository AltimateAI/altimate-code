---
title: "dbt Tools — Altimate Code"
description: "dbt tools in Altimate Code: dbt_run, dbt_manifest, dbt_unit_test_gen, and the dbt Power User tools for cost estimates, run results, docs coverage, project health, CTE timing, SQL graphs, relation mapping, defer state and shared-docs comments."
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

## dbt Power User tools

These tools bring dbt Power User features to the command line. Call them with `altimate-code tool run <id> --args '<json>'` (see [Tool CLI](../../usage/tool.md)) or from another coding agent through `altimate-code mcp serve`. The agent in the TUI does not offer them.

Some of them start the project's dbt integration (the dbt adapter), which runs `dbt deps` and renders the project's Jinja. Jinja `run_query` calls can run billed queries. A read-only call (`altimate-code tool run` without `--allow-write`, or plan mode) does not start the adapter, so these tools refuse it and say which of the two to change.

### Tools that start the dbt adapter and so need `--allow-write`

| Tool | What it returns | Parameters | What it runs on the warehouse |
| --- | --- | --- | --- |
| `dbt_cost_estimate` | The bytes a model or a query would scan, without running it. | `model` or `sql` (may use Jinja), not both | BigQuery: a dry run. Snowflake: `EXPLAIN USING JSON`, bytes left after pruning: an upper bound when the plan can size every source it reads. When it can't (an external table, a stage, a secure view, or a scan sized at zero), the answer says the figure is not a cap. Databricks: `EXPLAIN COST`, the sizes of the tables it reads, which can start a stopped SQL warehouse (billed while it runs). A query that may hold a second statement, or that reads files on Databricks, is refused rather than planned. |
| `dbt_health` | DataPilot project health insights per model, such as hard-coded references, missing tests or documentation, and naming and structure issues. | `config_path` (optional DataPilot config) | Nothing. It needs the `altimate-datapilot-cli` Python package in the project's Python. |
| `dbt_cte_profile` | Without `cte` or `position`: the model's CTEs in source order. With one: that CTE's row count and its warehouse time in milliseconds (`queryMs`, without dbt's start-up; `timing` says how it was measured, and `wall` means neither measure was available, so the time includes dbt's start-up). | `model` (name, unique_id or `.sql` path), `cte`, `position` | Listing runs nothing and works read-only. Timing runs `SELECT COUNT(*)` over that CTE and the CTEs before it, so a model of N CTEs costs N queries. |
| `dbt_sql_graph` | A model's CTEs, joins and filters as a graph, each relation tied to the dbt node it stands for. | `model` | Reads the column metadata of the model's parent relations. Runs no query on their data. |

### Read-only tools

| Tool | What it returns | Parameters |
| --- | --- | --- |
| `dbt_run_results` | The last dbt run from `target/run_results.json`: invocation id, command, elapsed seconds, finish time, counts, and one row per node with failures first (at most 200). A compile or parse writes success rows without building anything. | `project_dir`, `target_path` |
| `dbt_docs_coverage` | For one model: the output columns without a description in the project's YAML, the percent documented, and whether the model has a description. Needs a compiled manifest (`dbt compile`). | `model`, `manifest_path` |
| `dbt_map_relations` | For each table in a raw SQL query, the `ref()` or `source()` call that replaces it, how it matched (`exact`, `case_insensitive`, `partial`, `none`) and the candidates. | `sql`, `dialect`, `manifest_path`, `project_dir` |
| `dbt_defer_state` | The dbt Power User defer setting (`dbt.deferConfigPerProject`) and the profile's default target and target names. It reads only the workspace's `.vscode/settings.json`, not user settings or a `.code-workspace` file. | `project_dir`, `workspace_dir` |

### Shared-docs comments

`docs_share_comments` works on comment threads on dbt docs shared through Altimate. It needs you to be signed in.

- `action: "list"` returns the open threads for a dbt project: the shares you own and the threads you are tagged in. It can lag up to five minutes behind a new post.
- `action: "reply"` (with `share_id`, `group_id` and `text`) and `action: "resolve"` (with `share_id` and `group_id`) post under your name. They need write permission.

```bash
altimate-code tool run dbt_run_results
altimate-code tool run dbt_cost_estimate --allow-write --args '{"model":"fct_revenue"}'
altimate-code tool run docs_share_comments --args '{"action":"list"}'
```

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
modified during the session.

With `ALTIMATE_VALIDATORS_ENABLED=1`, confirmed findings block completion
with synthetic retries and inconclusive checks leave advisories. Set
`ALTIMATE_VALIDATORS_STRICT=1` to restore the previous retry policy.
`ALTIMATE_VALIDATORS_SHADOW=1` alone runs the checks for telemetry. When
neither flag is set the dispatch path is completely skipped and there
is zero overhead. See the [Validators page](../validators.md) for the
full reference, env var catalogue, performance characteristics, and
the phased rollout plan.
