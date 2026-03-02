---
name: lineage-diff
description: Compare column-level lineage and schema between two versions of a SQL model to show how data flow changed. Use when reviewing a PR that modifies SQL, when checking what a refactor changed in column lineage, or when investigating unexpected data flow differences between environments.
---

# Lineage Diff

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** lineage_check, dbt_lineage, dbt_manifest, schema_diff, warehouse_list, dbt_profiles, read, bash, glob

Compare two versions of a SQL model to identify changes in column-level data flow and structural schema changes.

## Workflow
1. **Detect dialect and warehouse context** -- Call `warehouse_list` or `dbt_profiles` to discover configured connections and auto-detect the SQL dialect (`snowflake`, `bigquery`, `postgres`, etc.). Pass the detected dialect to all subsequent tool calls that accept it.
2. **Get the original SQL (before)** -- Either:
   - Use `git show HEAD:<path>` via `bash` to get the last committed version
   - Use `git show <branch>:<path>` if comparing against a specific branch
   - Accept "before" SQL directly from the user
3. **Get the modified SQL (after)** -- Either:
   - `read` the current file on disk (working copy)
   - Accept "after" SQL directly from the user
4. **Run schema diff** -- Call `schema_diff` with the before SQL, after SQL, and detected `dialect`. This catches structural changes that affect data contracts:
   - **Dropped columns** -- Output columns that no longer exist
   - **Added columns** -- New output columns introduced
   - **Renamed columns** -- Columns that changed name
   - **Type changes** -- Columns whose data type changed
5. **Run column-level lineage on both versions** -- Choose the appropriate lineage tool:
   - **dbt project detected**: Call `dbt_lineage` for both versions if manifest covers both states. Fall back to `lineage_check` for the before version if the manifest only reflects the current state.
   - **SQL-only mode**: Call `lineage_check` with the before SQL and `dialect`, then again with the after SQL and `dialect`.
6. **Compute the lineage diff** -- Compare the two lineage results edge by edge:
   - **Added edges**: Data flow paths that exist in the new version but not the old
   - **Removed edges**: Data flow paths that existed in the old version but are gone
   - **Modified edges**: Same source-target pair but different transform expression
   - **Unchanged edges**: Identical in both versions

   Two edges match when all four fields are equal: `source_table`, `source_column`, `target_table`, `target_column`. The `transform` field is compared separately to detect logic changes on the same column path.
7. **Load DAG context (if dbt project)** -- Call `dbt_manifest` to understand where this model sits in the dependency graph. Report:
   - How many downstream models consume this model
   - Whether any removed edges feed columns used downstream
   - Suggest running `/impact-analysis` for full downstream classification
8. **Generate the lineage diff report**:

```
Lineage Diff: dim_customers
=============================

Dialect: snowflake (auto-detected)
Comparing: HEAD vs working copy

Schema Changes:
  + ADDED:   lifetime_value (NUMBER)
  - DROPPED: total_spend
  ~ RENAMED: email -> email_address
  ~ TYPE:    age (VARCHAR -> NUMBER)

Lineage Changes:

  + ADDED (new data flow):
    + raw_orders.amount -> dim_customers.lifetime_value  [SUM(amount)]
    + raw_customers.email -> dim_customers.email_address  [LOWER(email)]

  - REMOVED (data flow no longer exists):
    - raw_orders.amount -> dim_customers.total_spend  [SUM(amount)]
    - raw_customers.email -> dim_customers.email  [LOWER(email)]

  ~ MODIFIED (same column path, different transform):
    ~ raw_customers.birth_date -> dim_customers.age
      Before: DATEDIFF('year', birth_date, CURRENT_DATE)
      After:  FLOOR(DATEDIFF('day', birth_date, CURRENT_DATE) / 365.25)

  = UNCHANGED: 8 edges

Summary: 2 added, 2 removed, 1 modified, 8 unchanged
  Downstream models: 3 (run /impact-analysis for full assessment)
```

## Without dbt (SQL-only mode)

When no dbt project is detected:
1. Detect dialect via `warehouse_list`
2. Run `schema_diff` for structural changes
3. Run `lineage_check` on both versions with `dialect`
4. Compute and report the edge diff
5. Skip DAG context (no manifest available)

## Usage

- `/lineage-diff models/marts/dim_customers.sql` -- Compare current file against last git commit
- `/lineage-diff models/marts/dim_customers.sql main` -- Compare against a specific branch
- `/lineage-diff` -- Auto-detect the most recently modified SQL file from git status
