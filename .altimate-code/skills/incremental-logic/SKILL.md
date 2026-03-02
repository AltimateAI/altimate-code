---
name: incremental-logic
description: Add or fix incremental materialization logic in dbt models — is_incremental(), unique keys, merge strategies.
---

# Incremental Logic Assistant

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** glob, read, sql_analyze, lineage_check, schema_inspect, edit, write

Help convert batch models to incremental or fix existing incremental logic. Covers `is_incremental()` patterns, merge strategies, and common pitfalls.

## Workflow

1. **Read the model** — Use `glob` and `read` to find and understand the current model SQL
2. **Analyze the query** — Use `sql_analyze` to check for anti-patterns and `lineage_check` to understand column flow
3. **Inspect the schema** — Use `schema_inspect` to understand column types, especially timestamp columns
4. **Determine the strategy** — Choose the right incremental approach based on the data pattern
5. **Generate the incremental version** — Rewrite the model with proper `is_incremental()` logic
6. **Update config** — Add `unique_key`, `on_schema_change`, and strategy settings

## Incremental Strategies

### Append-Only (Event Logs)
Best for: immutable event streams where rows are never updated.
```sql
{{ config(
    materialized='incremental',
    on_schema_change='append_new_columns'
) }}

select
    event_id,
    event_type,
    payload,
    created_at
from {{ ref('stg_events') }}

{% if is_incremental() %}
where created_at > (select max(created_at) from {{ this }})
{% endif %}
```

### Merge/Upsert (Mutable Records)
Best for: records that can be updated (orders, customers).
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    merge_update_columns=['status', 'updated_at', 'amount'],
    on_schema_change='sync_all_columns'
) }}

select
    order_id,
    status,
    amount,
    created_at,
    updated_at
from {{ ref('stg_orders') }}

{% if is_incremental() %}
where updated_at > (select max(updated_at) from {{ this }})
{% endif %}
```

### Insert Overwrite (Partitioned)
Best for: date-partitioned fact tables, full partition replacement.
```sql
{{ config(
    materialized='incremental',
    incremental_strategy='insert_overwrite',
    partition_by={'field': 'event_date', 'data_type': 'date'},
    on_schema_change='fail'
) }}

select
    date_trunc('day', created_at) as event_date,
    count(*) as event_count
from {{ ref('stg_events') }}

{% if is_incremental() %}
where date_trunc('day', created_at) >= (select max(event_date) - interval '3 days' from {{ this }})
{% endif %}

group by 1
```

### Microbatch (Snowflake)
Best for: large tables needing controlled batch sizes.
```sql
{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    event_time='created_at',
    begin='2024-01-01',
    batch_size='day'
) }}

select * from {{ ref('stg_events') }}
```

## Common Pitfalls

| Issue | Problem | Fix |
|-------|---------|-----|
| Missing `unique_key` | Duplicates on re-run | Add `unique_key` matching the primary key |
| Wrong timestamp column | Missed updates | Use `updated_at` (not `created_at`) for mutable data |
| No lookback window | Late-arriving data missed | Use `max(ts) - interval '1 hour'` instead of strict `>` |
| `on_schema_change='fail'` | Breaks on column additions | Use `'append_new_columns'` or `'sync_all_columns'` |
| Full refresh needed | Schema drift accumulated | Run `dbt run --full-refresh -s model_name` |
| Stale `{{ this }}` | First run fails | `is_incremental()` returns false on first run — outer query runs unfiltered |

## Dialect-Specific Notes

| Warehouse | Default Strategy | Partition Support | Merge Support |
|-----------|-----------------|-------------------|---------------|
| Snowflake | `merge` | Yes (cluster keys) | Yes |
| BigQuery | `merge` | Yes (partition_by) | Yes |
| PostgreSQL | `append` | No native | No (use delete+insert) |
| DuckDB | `append` | No native | Partial |
| Redshift | `append` | Yes (dist/sort keys) | No (use delete+insert) |

## Usage

- `/incremental-logic models/marts/fct_orders.sql` — Convert to incremental
- `/incremental-logic fix models/marts/fct_orders.sql` — Fix existing incremental logic
- `/incremental-logic strategy orders` — Recommend best strategy for a table

Use the tools: `glob`, `read`, `sql_analyze`, `lineage_check`, `schema_inspect`, `edit`, `write`.
