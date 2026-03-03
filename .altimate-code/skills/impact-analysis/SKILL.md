---
name: impact-analysis
description: Analyze the downstream impact of SQL or dbt model changes by combining column-level lineage, schema diffing, and the dbt dependency graph. Use when a user changes a model and wants to know what breaks downstream, when reviewing a PR that modifies SQL, or when renaming/dropping columns.
domain: lineage
persona:
  - analytics-engineer
  - data-engineer
tools:
  - dbt_lineage
  - dbt_manifest
  - lineage_check
  - schema_diff
  - sql_analyze
  - warehouse_list
  - dbt_profiles
  - glob
  - bash
  - read
docs:
  - title: "dbt Model Governance"
    url: "https://docs.getdbt.com/docs/collaborate/govern/about-access"
    context: "Access modifiers, contracts, model versions for managing downstream impact"
  - title: "Column-Level Lineage"
    url: "https://docs.getdbt.com/docs/collaborate/column-level-lineage"
    context: "dbt Explorer column-level lineage for tracing data flow through models"
---

# Impact Analysis

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** dbt_lineage, dbt_manifest, lineage_check, schema_diff, sql_analyze, warehouse_list, dbt_profiles, glob, bash, read

Determine which downstream models, tests, and exposures are affected when a SQL model changes. Classify each impact as BREAKING, WARNING, or SAFE.

## Workflow
1. **Detect dialect and warehouse context** -- Call `warehouse_list` or `dbt_profiles` to discover configured connections and auto-detect the SQL dialect (`snowflake`, `bigquery`, `postgres`, etc.). Pass the detected dialect to all subsequent tool calls that accept it.
2. **Identify the changed model** -- Either:
   - Accept a model name or file path from the user
   - Detect changed `.sql` files via `git diff --name-only` using `bash`
   - If multiple models changed, analyze each one sequentially
3. **Obtain the before and after SQL** --
   - **Before**: `git show HEAD:<path>` via `bash` to get the last committed version
   - **After**: `read` the current file on disk
   - If the model is new (no prior version), skip diffing and report it as a new addition
4. **Run schema diff** -- Call `schema_diff` with the before SQL, after SQL, and detected `dialect`. This reveals:
   - **Dropped columns** -- Columns removed from the output (high break risk)
   - **Renamed columns** -- Columns that changed name (break risk unless downstream is updated)
   - **Type changes** -- Columns whose data type changed (subtle break risk)
   - **Added columns** -- New output columns (generally safe)
5. **Run column-level lineage** -- Choose the appropriate lineage tool:
   - **dbt project detected** (manifest exists): Call `dbt_lineage` with `manifest_path` and `model` name for manifest-aware lineage that resolves `ref()` and `source()` calls accurately. This is more reliable than SQL-only parsing.
   - **SQL-only mode**: Call `lineage_check` with the after SQL and `dialect` to trace column-level data flow from sources to output.
6. **Cross-reference schema changes with downstream consumers** -- Load the dbt DAG now (lazy): call `dbt_manifest` to get the full dependency graph. Use `glob` to search for `target/manifest.json` if the path is not provided. For complex projects with runtime vars, `dbt_manifest` provides the most accurate DAG. Extract downstream models by walking `depends_on` edges recursively with depth levels, identify tests and exposures. Then for each downstream model:
   - Read its SQL via `read`
   - Check if it references any dropped or renamed columns from step 4
   - If a dbt project is available, call `dbt_lineage` on the downstream model to trace which specific source columns it consumes
   - Otherwise, call `lineage_check` on its SQL with `dialect`
   - Classify the impact:

   | Classification | Condition | Action |
   |----------------|-----------|--------|
   | **BREAKING** | References a dropped or renamed column | Must update before deploy |
   | **WARNING** | References a type-changed column, or uses column in a CAST/comparison that may fail | Review and test |
   | **SAFE** | No reference to any changed column | No action needed |
7. **Run anti-pattern check** -- Call `sql_analyze` with the modified SQL and `dialect` to flag any new anti-patterns introduced by the change.
8. **Generate the impact report**:

```
Impact Analysis: stg_orders
============================

Dialect: snowflake (auto-detected)
Changed Model: stg_orders (materialized: view)

Schema Changes:
  DROPPED: total_amount
  RENAMED: order_total (was: total_amount)
  ADDED:   discount_pct
  TYPE:    quantity (NUMBER(10,0) -> NUMBER(18,0))

Downstream Impact (3 models, 4 tests affected):

  Depth 1:
    [BREAKING] int_order_metrics
      - References `total_amount` (DROPPED) in SUM(total_amount)
      - Action: Replace with `order_total`

    [SAFE] int_order_summary
      - No references to changed columns

  Depth 2:
    [BREAKING] mart_revenue
      - Cascading break via int_order_metrics.total_amount
      - Action: Fix int_order_metrics first, then verify

Tests at Risk: 4
  - not_null_stg_orders_total_amount (WILL FAIL: column dropped)
  - unique_int_order_metrics_order_id (OK)
  - accepted_values_stg_orders_status (OK)
  - relationships_int_order_metrics_order_id (OK)

Anti-Patterns in Modified SQL: 1
  - [WARNING] SELECT_STAR on line 3

Summary: 2 BREAKING, 0 WARNING, 1 SAFE
  Recommended: Fix int_order_metrics first, then run `dbt test -s stg_orders+`
```

## Without Manifest (SQL-only mode)

If no dbt manifest is available:
1. Run `schema_diff` to identify structural column changes between versions
2. Run `lineage_check` on the modified SQL with `dialect` to show column-level data flow
3. Report the schema changes and column lineage
4. Note that downstream impact cannot be fully determined without a manifest
5. Suggest running `dbt docs generate` or providing a manifest path

## Usage

- `/impact-analysis stg_orders` -- Analyze impact of changes to stg_orders
- `/impact-analysis models/staging/stg_orders.sql` -- Analyze by file path
- `/impact-analysis` -- Auto-detect changed models from git diff
