---
name: dbt-analyze
description: Analyze downstream impact of dbt model changes using column-level lineage and the dependency graph. Use when evaluating the blast radius of a change before shipping. Powered by altimate-dbt.
---

# dbt Impact Analysis

## Requirements
**Agent:** any (read-only analysis)
**Tools used:** bash (runs `altimate-dbt` commands), read, glob, dbt_manifest, lineage_check, sql_analyze

## When to Use This Skill

**Use when the user wants to:**
- Understand what breaks if they change a model
- Evaluate downstream impact before shipping
- Find all consumers of a model or column
- Assess risk of a refactoring

**Do NOT use for:**
- Creating or fixing models → use `dbt-develop` or `dbt-troubleshoot`
- Adding tests → use `dbt-test`

## Workflow

### 1. Identify the Changed Model

Accept from the user, or auto-detect:
```bash
# From git diff
git diff --name-only | grep '\.sql$'

# Or user provides a model name
altimate-dbt compile --model <name>    # verify it exists
```

### 2. Map the Dependency Graph

```bash
altimate-dbt children --model <name>    # direct downstream
altimate-dbt parents --model <name>     # what feeds it
```

For the full downstream tree, recursively call `children` on each downstream model.

### 3. Run Column-Level Lineage

Use the `lineage_check` tool on the changed model's SQL to understand:
- Which source columns flow to which output columns
- Which columns were added, removed, or renamed

### 4. Cross-Reference with Downstream

For each downstream model:
1. Read its SQL
2. Check if it references any changed/removed columns
3. Classify impact:

| Classification | Meaning | Action |
|---------------|---------|--------|
| **BREAKING** | Removed/renamed column used downstream | Must fix before shipping |
| **SAFE** | Added column, no downstream reference | Ship freely |
| **UNKNOWN** | Can't determine (dynamic SQL, macros) | Manual review needed |

### 5. Generate Impact Report

```
Impact Analysis: stg_orders
════════════════════════════

Changed Model: stg_orders (materialized: view)
  Columns: 5 → 6 (+1 added)
  Removed: total_amount (renamed to order_total)

Downstream Impact (3 models):

  Depth 1:
    [BREAKING] int_order_metrics
      Uses: total_amount → COLUMN RENAMED
      Fix: Update column reference to order_total

    [SAFE] int_order_summary
      No references to changed columns

  Depth 2:
    [BREAKING] mart_revenue
      Uses: total_amount via int_order_metrics → CASCADING
      Fix: Verify after fixing int_order_metrics

Tests at Risk: 4
  - not_null_stg_orders_order_total
  - unique_int_order_metrics_order_id

Summary: 2 BREAKING, 1 SAFE
  Recommended: Fix int_order_metrics first, then:
  altimate-dbt build --model stg_orders --downstream
```

## Without Manifest (SQL-Only Mode)

If no manifest is available:
1. Run `lineage_check` on the changed SQL
2. Show column-level data flow
3. Note: downstream impact requires a manifest
4. Suggest: `altimate-dbt build-project` to generate one

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Only checking direct children | Always trace the FULL downstream tree recursively |
| Ignoring test impacts | Check which tests reference changed columns |
| Shipping without building downstream | Always `altimate-dbt build --model <name> --downstream` |
| Not considering renamed columns | A rename is a break + add — downstream still references the old name |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [references/altimate-dbt-commands.md](references/altimate-dbt-commands.md) | Need the full CLI reference |
| [references/lineage-interpretation.md](references/lineage-interpretation.md) | Understanding lineage output |
