---
name: incremental-logic
description: Convert dbt models to incremental materialization. Covers unique_key, is_incremental() filter, merge/append/delete+insert strategies, and full-refresh considerations.
---

# Incremental Materialization in dbt

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** bash (runs `altimate-dbt` commands), read, write, edit, dbt_profiles, altimate_core_validate

## When to Use This Skill

**Use when the user wants to:**
- Convert a `table` or `view` model to incremental
- Choose the right incremental strategy (merge, append, delete+insert)
- Add the `is_incremental()` filter to limit rows processed
- Handle late-arriving data or out-of-order timestamps
- Understand when to run `--full-refresh`

**Do NOT use for:**
- Creating a new model from scratch → use `model-scaffold` or `dbt-develop`
- Debugging incremental failures → use `dbt-troubleshoot`

## Core Concepts

### Why Incremental?
Full `table` refreshes reprocess all rows on every run. For large fact tables (events, transactions, logs), incremental processing cuts runtime from hours to minutes by processing only new/changed rows.

### The Pattern
```sql
{{ config(
    materialized='incremental',
    unique_key='<pk_column>',
    incremental_strategy='merge'   -- or 'append', 'delete+insert'
) }}

with source as (
    select * from {{ ref('stg_events') }}

    {% if is_incremental() %}
    -- Only process rows newer than the latest row already in the table
    where event_at > (select max(event_at) from {{ this }})
    {% endif %}
)

select * from source
```

## Strategy Selection

| Strategy | Use When | Adapter Support |
|---|---|---|
| `append` | Rows are immutable; new rows only; no duplicates | All |
| `merge` | Rows can be updated; `unique_key` identifies records | Snowflake, BigQuery, Databricks, Postgres |
| `delete+insert` | Partitioned tables; delete matching partition then insert | Snowflake, BigQuery |
| `insert_overwrite` | Partition-based overwrite (Spark/Databricks) | Databricks, Spark |

## Step-by-Step Conversion

### 1. Read the Model
```bash
altimate-dbt columns --model <name>
```
Identify:
- The primary key (for `unique_key`)
- The timestamp column used to filter new rows
- Whether rows can be updated after insert (determines strategy)

### 2. Choose Strategy

**Append:** Events that never update (e.g., raw logs, immutable events)
```sql
{{ config(materialized='incremental', incremental_strategy='append') }}
```

**Merge:** Records that can be updated (e.g., order status changes)
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge'
) }}
```

**Delete+Insert:** Partition-based (e.g., daily partitions)
```sql
{{ config(
    materialized='incremental',
    unique_key=['date_day', 'warehouse_id'],
    incremental_strategy='delete+insert',
    partition_by={'field': 'date_day', 'data_type': 'date'}
) }}
```

### 3. Add is_incremental() Filter

Always filter on a monotonically increasing column (usually a timestamp):
```sql
{% if is_incremental() %}
where updated_at > (select max(updated_at) from {{ this }})
{% endif %}
```

For late-arriving data, add a lookback buffer:
```sql
{% if is_incremental() %}
where updated_at > (select dateadd('day', -3, max(updated_at)) from {{ this }})
{% endif %}
```

### 4. Validate

```bash
altimate-dbt compile --model <name>     # catch Jinja errors
altimate-dbt build --model <name>       # first run (creates table)
altimate-dbt build --model <name>       # second run (exercises incremental path)
```

Check row counts are stable on the second run:
```bash
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('<name>') }}" --limit 1
```

## Full-Refresh Considerations

`dbt build --full-refresh` drops and recreates the table from scratch. Do this when:
- Schema changes (new columns added)
- `unique_key` or strategy changes
- Historical data needs reprocessing (bug fix)

Document in schema.yml if a model should rarely be full-refreshed (e.g., very large tables).

## Iron Rules

1. **Always add `is_incremental()` filter** — without it, every run processes all rows.
2. **`unique_key` must be truly unique** — duplicates in source cause incorrect merges.
3. **Test the incremental path explicitly** — run the model twice and verify idempotence.
4. **Use `merge` by default** — safer than `append` unless you have proven immutability.
5. **Never use `SELECT *` in incremental models** — schema drift breaks incremental runs silently.
