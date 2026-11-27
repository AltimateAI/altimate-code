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

## dbt_cost_estimate

What a BigQuery dbt model's compiled query would scan before it runs and, when asked with `history: true`, what the model cost the last times it ran. Pass `model` (a model name, as dbt's `ref()` takes it) or `sql`. It starts the dbt adapter, so it needs write permission: pass `--allow-write` on `tool run` or the MCP server, and leave plan mode, or a read-only call is refused.

BigQuery only: on any other warehouse (Snowflake, Databricks, Redshift, Postgres, DuckDB and the rest) the tool answers `supported: false` with the adapter's name and the text "cost estimates are only available on BigQuery", and compiles nothing.

### Default call

Without `history: true` the tool compiles and dry runs only, sends no `INFORMATION_SCHEMA` query and returns the scan figure with no `cost`. The figure comes from a BigQuery dry run (`bytes`, `maxBytes`, `lowerBound`). The byte count is parsed from the dry run's display, which has one decimal ("4.2 TiB"), so it can be off by up to half a tenth of its unit; `maxBytes` gives the upper end. A script's dry run can skip statements or omit work that happens at run time, so `lowerBound` marks it, and a zero estimate is marked too.

```bash
altimate-code tool run dbt_cost_estimate --allow-write --args '{"model":"fct_revenue"}'
```

### With `history: true`

Pass `history: true` when you ask what a model costs or what its runs cost. The answer then has a `cost` block, first in the text. It reports the last run, the typical (median) run and the highest, in money and in BigQuery's own unit (bytes billed or slot-hours), from the model's runs in the last 30 days, priced at a stated rate (`cost.rate`: `config` or `default`). That is reported usage at a rate, an estimate and not an invoice amount, and the tool never invents a cost when no history was read. A history that mixes on-demand and reservation runs has no single native unit, so `cost.native` is omitted. `cost.attribution` is `bytes_billed`, `slot_time` or `mixed`, and `cost.scope` is `project` or `user` (see below).

- **Current target.** The jobs are split by target before they are grouped, so a run never mixes targets, and the figures are of the runs of the dbt target the adapter is using (`target.name`, matched with `"target_name"` in dbt's query comment). Runs of other targets (dev, CI) and runs whose comment names no target are not in the figures: they are listed in `cost.otherTargets` (`target`, `runs`, `typical`; the latter under "unknown target") and in one note. If the current target has no runs but others do, nothing is the headline cost and the answer says so.
- **Only your own jobs.** When the role cannot list every user's jobs (it lacks `bigquery.jobs.listAll`), the tool reads `JOBS_BY_USER`, which returns only the caller's own jobs. The first line of the answer then says "Only your own jobs were read (no bigquery.jobs.listAll): service-account and other users' runs are missing", and `cost.scope` is `user`.
- **Reservations.** A run in a reservation is priced by its slot time, which is attributed, not billed: the first line says "reservation runs are attributed slot time, not the bill". Autoscaled slots are billed in steps of 50, by default with a one-minute minimum (reservations with fluid scaling have none), and baseline slots are always charged, so slot time is an allocation, not the bill. The default 0.06 USD per slot-hour is the BigQuery Enterprise pay-as-you-go rate (Standard is 0.04, commitments are lower): set `cost.bigquerySlotHourUsd`.
- **When cost cannot be known**, `cost.unknownReason` says why (`basis` is `none` and the answer contains a "Cost unknown: <reason>" line, after the own-jobs notice when there is one; a dry-run price, when there is one, stays in `cost.selectOnly` and in its own line, "Pre-run scan estimate (not the model's run history)", and is never the headline): no runs in the window, a role without access (it needs `bigquery.jobs.create` and `bigquery.jobs.listAll` on the project, or `bigquery.jobs.create` and `bigquery.jobs.list` for its own jobs), a `sql` input (it has no history), a model name that matches several nodes, an ephemeral model (it never runs on its own; its SQL is inlined into the models that ref it), or a Python model (it runs on Dataproc and never appears in `INFORMATION_SCHEMA.JOBS`; no query is sent for it). Every no-runs message names the location read: a target with no `location` reads `region-us`, and the message says so. When the model's runs and the 7-day check disagree on reservation versus on-demand pricing, or the newest run differs from older ones, a note says so.
- **Runs left out** are counted with the cause: a non-cached job with no bytes billed (a cache hit is a known $0 run), a reservation job with no slot time, a script whose child jobs were not found, may be cut off at the query's limit, or whose start time could not be read.

```bash
altimate-code tool run dbt_cost_estimate --allow-write --args '{"model":"fct_revenue","history":true}'
```

### How runs are counted

The tool finds the model's jobs by dbt's query comment (`"node_id": "<unique_id>"`, matched as exact text), so every user and every dbt target that use the same execution project are found. The matched jobs are the top-level jobs that carry the comment, of any statement type (builds, hooks, SELECTs, DELETE and UPDATE; the tool's own reads are excluded by a marker), those that finished and those still queued or running, newest 500. When a query returns all 500, the answer says only the newest 500 were read.

- **By invocation.** dbt-bigquery labels every job it runs with `dbt_invocation_id`, which the history and boundary reads select from `INFORMATION_SCHEMA.JOBS` (`labels`). Jobs with the same id are one run, however far apart they are, and two invocations by one user within a minute are two runs.
- **Without the label** (an older adapter, a job dbt did not run) jobs are grouped by user and time: the matched top-level jobs by one user form a run while each job starts within 60 seconds after the previous job of the run ended. That covers pre- and post-hooks, DELETE and UPDATE, and every batch of a microbatch model. Jobs are split by target first, so within one target, invocations by one user that overlap or follow within 60 seconds (for example two CI runs from one service account) are then one run; jobs whose comment names no target are grouped among themselves.
- **A run needs a build job** (create, insert, merge, script). A group of reads, such as `dbt show`, is not a run and is not priced.
- **Temporary relation.** A CREATE TABLE AS SELECT into dbt's temporary relation (a table ending in `__dbt_tmp`) pairs, for unlabelled jobs, with the MERGE, INSERT or script by the same user, in the same destination dataset, that starts within 10 minutes after it ends: each such CTAS takes the first qualifying build no other CTAS has taken, since dbt makes one temporary relation per build.
- **Scripts** are priced from their child jobs, each by its own pricing mode (bytes billed on demand, slot time in a reservation), never the script row beside them. The child jobs are read from the earliest matched script's creation onward, so they cannot slide out of the 30-day window while the scripts are read.
- **Runs still going.** A run with a job still queued or running, or whose last job ended within 60 seconds of the instant read, or within 10 minutes after a temporary-table CTAS that no final build has taken (whatever ran after it), is left out and counted in a note.
- **Boundary jobs and targets.** Boundary and still-going jobs carry their `target_name` like the history: a job can drop or hold a run of its own target only, and a job naming no target only a run naming none.
- **Runs that began before the period.** A second query (the boundary) reads the jobs before the period read (the oldest job returned, else the 30-day edge) that could belong to a run: for a run whose jobs carry an invocation id, an unread job with the same id (every finished job of the invocations read, as far back as `INFORMATION_SCHEMA.JOBS` keeps jobs, 180 days, since an invocation has no span limit, so a labelled run is complete exactly when all its jobs were read; the 96-hour-10-minute fallback of a full or unknown read is for unlabelled runs only) or a job still going with the same id; labelled and unlabelled jobs are never one run, so neither meets the other here; otherwise a job by the same user that ended at or after 60 seconds before the run's start, or a temporary-relation CTAS by the same user, into the dataset of a final build, that ended within 10 minutes before it. Such a run is dropped and the answer counts the runs dropped. Jobs still going (queued, running, or with no end time) are listed first, so finished jobs cannot crowd them out, and a run one of them could join is left out wherever it is. If the read is full, runs starting within 96 hours 10 minutes of the cutoff are also dropped, and every unlabelled run by a user with a job still going (a labelled run is judged by its own invocation: left out only when a job of the same id is still going, or when the invocation read is full). If the boundary read fails or times out, the tool cannot tell which runs are still going or were cut, so no run is priced: the history is unknown ("could not check for runs still in progress: ...") and the scan fields stay.
- **The 96 hours 10 minutes** is BigQuery's longest job span plus the longest join gap: a query waits in the queue 6 hours when interactive and 24 hours when batch by default, and the queue timeout can be set up to 48 hours; it then runs up to 6 hours per attempt with up to three attempts, but a CREATE MODEL statement (BigQuery ML) times out at 24 hours, or 48 hours for time series, AutoML and hyperparameter tuning, so at most 48 + 48 = 96 hours in flight, and a temporary-table CTAS joins its final job up to 10 minutes after it ends. A job that was queued and running longer than that, for example under a queue timeout raised in the project's settings, and has since finished, is not covered. A job still going is read from no further back than that span either.

### What each number means

- **History, on demand:** bytes billed per job (`total_bytes_billed`, the charged amount) per TiB at the on-demand rate. A BigQuery ML job (`CREATE_MODEL`, at the top level or among a script's children) that ran on demand is the exception: model training bills at its own price, not the query rate, so its cost is unknown and its run is left out, with a cause naming BigQuery ML. In a reservation its slot time is priced like any job's. A cached job bills nothing; a non-cached job with no bytes billed (BigQuery hides them for tables under a row access policy) is unknown and its run is left out.
- **History, reservation:** attributed slot time at the slot-hour rate (see Reservations above). When a model has both kinds of run, `cost.rate` is the newest run's and a note names the on-demand rate.
- **Pre-run scan price** (`cost.selectOnly.estimate`, on on-demand pricing only): the dry run's byte count, at least BigQuery's 10 MiB per-query minimum, times the on-demand rate. It is an estimate, not a bound, and the text says so: the bill can differ, because a cached or BI Engine result bills nothing, clustered tables often bill less after runtime pruning, and external sources and some queries are not fully counted. It covers the SELECT only; depending on its strategy, an incremental model can also write a temp table and read the target, which the history shows.
- **A zero estimate** is not priced: BigQuery also reports 0 bytes for row-level security, external (federated) tables and cached results, and the note says so. A script's dry run is not priced either.
- **Capacity pricing:** if the project is on capacity pricing the dry run is not priced, and neither is it when the pricing mode can't be read (the project's jobs, then your own, show no query job in 7 days or can't be listed).

### Queries and their cost

Each `history: true` call runs up to eight billed `INFORMATION_SCHEMA.JOBS` queries: three normally (capacity, history and boundary), one more to read the earlier jobs of labelled invocations (the invocation read), one more when a script matched (its children), so up to five, and up to eight when the role cannot list every user's jobs, since the capacity, history and children reads each run again on `JOBS_BY_USER`.

| Query | Reads |
|---|---|
| Capacity check | 7 days of jobs, to tell on-demand from reservation pricing |
| History | 30 days: `strpos` on the query text scans the query text of every query job in the project, so the bytes grow with the project's activity, not the model, and the 500-row cap limits the rows returned, not the bytes billed |
| Boundary | one query: finished jobs from the 96 hours 10 minutes before the period read, plus the model's jobs still queued or running from no further back than that; it scans query text like the history, over that shorter span |
| Invocation jobs | only when runs carry an invocation label: the jobs of those invocations from before the cutoff, back to the 180 days JOBS keeps, in a read of their own with its own 500-row limit; if it is full, no labelled run is known to be complete and every labelled run is left out |
| Children | the child jobs of matched scripts, by parent id |

Each is billed on demand (at least 10 MiB per query) or uses reservation slots, and `INFORMATION_SCHEMA` results are never cached, so you are charged each time. Leave `history` off for a routine pre-run check. The queries run through dbt's `run_query`, which cannot set `maximum_bytes_billed` per query: if the profile sets `maximum_bytes_billed`, the queries follow it. All queries read the same instant, taken once per call and written as a literal into the history, boundary and capacity queries (the children query starts at the earliest matched script's creation instead), so those queries describe one period.

The pre-run scan runs first and completes before the history queries start (the dbt Python bridge serialises adapter calls). The history has its own 60 s deadline, which only stops the tool waiting: the warehouse may keep running a history query. The history never changes the scan figure.

### Config

Set your own rates in the config (see [Configuration](../../configure/config.md)):

```json
{
  "cost": {
    "bigqueryUsdPerTib": 6.25,
    "bigquerySlotHourUsd": 0.06
  }
}
```

A rate you set replaces the default: `bigqueryUsdPerTib` prices on-demand jobs, `bigquerySlotHourUsd` prices jobs that ran in a reservation. Each should be a positive number of at most 1,000,000; the config accepts any number, and the tool ignores any other value and names the key in its notes, using the default rate instead.

### Not covered

- Warehouses other than BigQuery (no estimate is given).
- Continuous queries: dbt submits none, and every read (capacity, history, boundary, invocation and children) leaves out jobs that `INFORMATION_SCHEMA.JOBS` marks `continuous`; one that carried the model's query comment anyway would not be covered by the in-progress checks.
- Python models (they run on Dataproc, not as query jobs).
- Jobs that were in flight longer than 96 hours 10 minutes and have finished, and runs outside the 30-day window or beyond the newest 500 jobs.
- The reservation bill itself: slot time is attributed, not the invoice.
- Figures not yet compared with real billing: the tests use a mocked adapter, so compare dry-run bytes with billed bytes, and the history totals with your billing export, over a few dozen dbt runs before relying on them.

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
| `dbt_cost_estimate` | The bytes a BigQuery model or a query would scan, without running it; with `history: true`, also what the model cost its earlier runs. Any other warehouse answers `supported: false`. | `model` or `sql` (may use Jinja), not both; optional `history` (default false): `true` also reads what earlier runs cost | A BigQuery dry run for the scan; with `history: true`, billed `INFORMATION_SCHEMA.JOBS` queries. |
| `dbt_health` | DataPilot project health insights per model, such as hard-coded references, missing tests or documentation, and naming and structure issues. | `config_path` (optional DataPilot config) | Nothing. It needs the `altimate-datapilot-cli` Python package in the project's Python. |
| `dbt_cte_profile` | Without `cte` or `position`: the model's CTEs in source order, including `reads`, the positions of earlier CTEs each body names directly. These approximate dependencies let clients estimate own time by subtracting dependency times once, rather than subtracting the preceding sibling. Quoted-name case rules and backslash strings vary by warehouse; this dialect-independent scan can miss or overcount reads, as can aliases and Jinja-generated names. With one: that CTE's row count and its warehouse time in milliseconds (`queryMs`, without dbt's start-up; `timing` says how it was measured, and `wall` means neither measure was available, so the time includes dbt's start-up). | `model` (name, unique_id or `.sql` path), `cte`, `position` | Listing runs nothing and works read-only. Timing runs `SELECT COUNT(*)` over that CTE and the CTEs before it, so a model of N CTEs costs N queries. |
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
altimate-code tool run dbt_cost_estimate --allow-write --args '{"model":"fct_revenue","history":true}'
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
modified during the session and block "done" if anything failed.

This is **opt-in** today via either `ALTIMATE_VALIDATORS_ENABLED=1`
(enforcement mode — failing validators block "done" with synthetic
retries) or `ALTIMATE_VALIDATORS_SHADOW=1` (telemetry-only mode — runs
without blocking, useful for measuring "would have caught" rates). When
neither flag is set the dispatch path is completely skipped and there
is zero overhead. See the [Validators page](../validators.md) for the
full reference, env var catalogue, performance characteristics, and
the phased rollout plan.
