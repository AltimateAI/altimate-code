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

## dbt_fault_injection

Find the upstream data faults a dbt project's own tests would miss.

It corrupts one upstream relation at a time in a private copy of the database, rebuilds every model
downstream of it, runs the project's tests, and reports which faults no test noticed. It is
deterministic and uses no model, so it is also available as a plain command that needs no API key:

```bash
altimate-code fault-injection                      # the dbt project in the current directory
altimate-code fault-injection path/to/project --budget 50
altimate-code fault-injection --model stg_orders   # corrupt only this model, seed or source
altimate-code fault-injection --format json --fail-under 60   # for CI
```

**Parameters** (tool) / **flags** (command):
- `project_dir` / `[project]` (optional): dbt project root. Defaults to the working directory
- `budget` / `--budget` (optional, default 20): maximum number of faults to inject
- `model` / `--model` (optional): corrupt only this model, seed, snapshot or source
- `target` / `--target`, `profiles_dir` / `--profiles-dir` (optional): as for dbt
- `--seed`, `--work-dir`, `--format text|json`, `--fail-under <percent>`: command only

The seven faults are duplicated rows, dropped rows, a column set to NULL, a number multiplied by 100,
a category value never seen before, a date moved one day, and a foreign key pointing nowhere. Each
touches 5% of the eligible rows of one relation (at least one row).

### Reading the output

A real run on the 5-model jaffle_shop project, trimmed (`...` marks removed lines):

```
Fault injection: jaffle_shop_snowflake (duckdb)

Catch rate: 68.0% (34 of 50 faults that mattered were caught)
  50 faults injected: 34 caught, 16 slipped through, 0 harmless, 0 invalid
  ...

Slipped through (16): the project's tests did not notice these

1. seed raw_customers: `first_name` set to NULL in 5 of 100 rows
   Fault id: jaffle_shop_snowflake|seed.jaffle_shop_snowflake.raw_customers|null_out|first_name
   5 tests ran and none failed because of the fault. Changed downstream:
     - model customers: 5 rows changed (first_name: 5) of 100 (matched on customer_id)
     - model sample: content changed, row count unchanged at 100; no unique key is declared for this relation, so no row-level detail
     ...
   Proposed test: not_null
   Verified on the data: passes on the clean data and fails on the corrupted copy (5 failing).
      seeds:
        - name: raw_customers
          columns:
            - name: first_name
              data_tests:
                - not_null
   Note: `first_name` has no NULL in the baseline, so a `not_null` test passes today and fails on the first NULL.
...
3. seed raw_orders: `order_date` moved one day later in 5 of 99 rows
   ...
   No test is proposed for this fault: `order_date` is a date or timestamp, and a one-day shift stays inside the span the data legitimately covers. ...
...
8. seed raw_payments: `amount` multiplied by 100 in 6 of 113 rows
   ...
   Proposed test: range (singular test)
   Verified on the data: passes on the clean data and fails on the corrupted copy (1 failing).
   The standard test for this needs a package this project has not installed, so this is a singular test (plain SQL, no package needed).
   Save as tests/fault_injection/fault_injection__raw_payments__range__amount.sql (or in another folder listed under test-paths in dbt_project.yml):
      SELECT * FROM {{ ref('raw_payments') }} WHERE "amount" < 0 OR "amount" > 100000
...
These are gaps in the project's tests. They are not evidence that the data in the warehouse today is wrong.
Took 195s: setup and baseline build 6.1s; 50 faults 139s (2.8s each on average); profiling and no-fault controls 51s.
```

- **Caught**: a test failed, or a downstream model failed to build
- **Slipped through**: no test failed and downstream data changed. These are the findings
- **Harmless**: nothing downstream changed, so the fault is left out of the catch rate
- **Invalid**: the fault touched no row, or its sandbox failed twice
- **Catch rate**: caught / (caught + slipped through), rounded down

Each slipped fault lists the downstream models that changed, row by row where the model has a
declared unique key and by row count and checksum otherwise, and either a test that would catch it
or the reason there is none.

A proposed test is offered only if it passes on the clean data and fails on the corrupted copy (both
are checked by running it) and is unlikely to be a snapshot of today's data. So:

- A range is not the column's current minimum and maximum. It leaves an order of magnitude of room,
  and a fault that stays inside that room gets no range test.
- A column computed from the current date or time (found from the model's SQL, through its parents,
  and from relations that change on every rebuild with no fault injected) gets no range, no list of
  values and no non-null-share floor, because they would fail as the clock moves.
- A list of accepted values is proposed only for a column that is plausibly a category: at most 20
  distinct values, at least 30 non-null rows and at least 10 rows per value. Such a column is also the
  only kind the "new category value" fault is injected into.
- A date moved by one day gets no test: any range narrow enough to see it fails when the next row arrives.
- A test for a model or source that an installed dbt package defines, or one whose standard test
  needs a package the project has not installed, is a singular test (a SQL file to save under
  `tests/`) because dbt accepts only one schema entry per resource.
- A `relationships` test names its parent from what the project already declares (relationship tests,
  foreign-key constraints), from joins in the models that read the column, and from declared keys, and
  is offered only if it verifies on both copies. With no parent that verifies, the report says so.

`--format json` prints the same result as JSON, including every executed fault (not only the ones
that slipped through), the no-fault controls and per-fault timings.

!!! note
    Findings are gaps in the project's tests. They are not evidence that the data in the warehouse
    today is wrong: the corruption only ever exists in the copy.

### Cost

One `dbt build --full-refresh` of the models, seeds and snapshots on the copy, then for every
corrupted relation three no-fault control runs, and for every fault one `dbt run` of the downstream
models plus one `dbt test`. All of it is single-threaded. The run above took 158 seconds on a
laptop for 52 faults over 6 relations. The controls are a fixed cost per relation, so a small budget
spread over many relations is dominated by them: on a larger project, 20 faults spread over 17
relations took 186 seconds, 129 of them in profiling and controls. Use `--model` to concentrate the
budget.

### Safety

dbt runs on a copy of the database and a copy of the project, both in a temporary directory (or
`--work-dir`), with its own profile, target path and log path. The directory is removed on success,
failure and interrupt, and the command reports where it was. The project's database is opened only
to copy it, and the command checks afterwards that its size and modification time are unchanged.

It refuses to run when it can see that dbt would reach beyond that copy: an in-memory or MotherDuck
database, a profile with `attach` or `plugins`, a database with a pending write-ahead log, a model
with the `external` materialization, a relation in another database, or a hook that runs `ATTACH`,
`COPY` or `EXPORT DATABASE`.

It does not inspect what macros and Python models do. Code there that writes to an absolute path, or
attaches another database by absolute path, would act on the real thing. A `kill -9` leaves the
temporary directory behind.

### Limits

- **DuckDB only.** Any other warehouse is refused before anything runs
- The models, seeds and snapshots must build on the copy; a build error stops the run. Tests that
  already fail do not: they are reported and cannot catch a fault
- Needs dbt-core (not dbt Fusion) with the project's adapter. Set `ALTIMATE_DBT_PATH` if dbt is not
  found
- Needs an `@altimateai/altimate-core` that includes the fault-injection engine; the command says so
  when the installed one does not
- Row-level detail (which columns changed in how many rows) needs a declared unique key. Up to 16,384
  rows both versions of a changed model are compared in full. Above that, up to 2,000,000 rows, the
  command compares a hash of every row and then reads only the changed rows, which is exact for the
  counts of added, removed and changed rows; when more than 20,000 rows changed the per-column
  counts come from the first 20,000 of them, and the report says so. A 580,000-row model took about
  7 seconds per fault in a test on a loaded laptop. Larger models keep the row count and checksum.
- A proposed test assumes the data keeps its shape: an accepted-values list fails when a new
  legitimate value first appears, and a row-count floor when the model legitimately shrinks.
- Each fault copies the database once. On filesystems without copy-on-write clones that is a full
  copy per fault

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
altimate-dbt execute "SELECT 1"    # Run a query via dbt adapter
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
