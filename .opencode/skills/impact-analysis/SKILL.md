---
name: impact-analysis
description: Analyze the downstream impact of changes to a dbt model by combining column-level lineage with the dbt dependency graph.
---

# Impact Analysis

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** dbt_manifest, lineage_check, sql_analyze, glob, bash, read

Determine which downstream models, tests, and dashboards are affected when a dbt model changes.

## Workflow

1. **Identify the changed model** — Either:
   - Accept a model name or file path from the user
   - Detect changed `.sql` files via `git diff --name-only` using `bash`

2. **Load the dbt manifest** — Call `dbt_manifest` with the project's `target/manifest.json` path.
   - If the user specifies a manifest path, use that
   - Otherwise search for `target/manifest.json` or `manifest.json` using `glob`

3. **Find the changed model in the manifest** — Match by model name or file path.
   Extract: `unique_id`, `depends_on`, `columns`, `materialized`

4. **Build the downstream dependency graph** — From the manifest:
   - Find all models whose `depends_on` includes the changed model's `unique_id`
   - Recursively expand to get the full downstream tree (depth-first)
   - Track depth level for each downstream model

5. **Run column-level lineage** — Call `lineage_check` on the changed model's SQL to get:
   - Which source columns flow to which output columns
   - Which columns were added, removed, or renamed (if comparing old vs new)

6. **Cross-reference lineage with downstream models** — For each downstream model:
   - Check if it references any of the changed columns
   - Run `lineage_check` on the downstream model's SQL if available
   - Classify impact: BREAKING (removed/renamed column used downstream), SAFE (added column, no downstream reference), UNKNOWN (can't determine)

7. **Generate the impact report**:

```
Impact Analysis: stg_orders
════════════════════════════

Changed Model: stg_orders (materialized: view)
  Source columns: 5 → 6 (+1 added)
  Removed columns: none
  Modified columns: order_total (renamed from total_amount)

Downstream Impact (3 models affected):

  Depth 1:
    [BREAKING] int_order_metrics
      References: order_total (was total_amount) — COLUMN RENAMED
      Action needed: Update column reference

    [SAFE] int_order_summary
      No references to changed columns

  Depth 2:
    [BREAKING] mart_revenue
      References: order_total via int_order_metrics — CASCADING BREAK
      Action needed: Verify after fixing int_order_metrics

Tests at Risk: 4
  - not_null_stg_orders_order_total
  - unique_int_order_metrics_order_id
  - accepted_values_stg_orders_status
  - relationships_int_order_metrics_order_id

Summary: 2 BREAKING, 1 SAFE, 0 UNKNOWN
  Recommended: Fix int_order_metrics first, then run `dbt test -s stg_orders+`
```

## Without Manifest (SQL-only mode)

If no dbt manifest is available, fall back to SQL-only analysis:
1. Run `lineage_check` on the changed SQL
2. Show the column-level data flow
3. Note that downstream impact cannot be determined without a manifest
4. Suggest running `dbt docs generate` to create a manifest

## Tools Used

- `dbt_manifest` — Load the dbt dependency graph
- `lineage_check` — Column-level lineage for each model
- `sql_analyze` — Check for anti-patterns in changed SQL
- `glob` — Find manifest and SQL files
- `bash` — Git operations for detecting changes
- `read` — Read SQL files from disk

## Usage Examples

- `/impact-analysis stg_orders` — Analyze impact of changes to stg_orders
- `/impact-analysis models/staging/stg_orders.sql` — Analyze by file path
- `/impact-analysis` — Auto-detect changed models from git diff
