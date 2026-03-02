---
name: incremental-logic
description: >
  Add or fix incremental materialization logic in dbt models.
  Use when the user asks to convert a model to incremental, fix is_incremental() logic,
  choose an incremental strategy, troubleshoot duplicate rows, or optimize large table builds.
---

# Incremental Logic Assistant

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** warehouse_list, dbt_profiles, dbt_manifest, glob, read, sql_analyze, lineage_check, schema_inspect, edit, write

Help convert batch models to incremental or fix existing incremental logic. Covers `is_incremental()` patterns, strategy selection, merge keys, and common pitfalls.

## Workflow

1. **Detect the warehouse dialect** -- This is the critical first step. Never assume a dialect.
   - Call `warehouse_list` to check for configured connections
   - If no connections found, call `dbt_profiles` to discover warehouse type from dbt configuration
   - If neither yields a result, ask the user which warehouse they are using
   - The dialect determines which incremental strategies are available

2. **Read the model** -- Use `glob` and `read` to find and understand the current model SQL

3. **Check existing config** -- Call `dbt_manifest` to detect whether the model is already incremental, its current strategy, unique_key, and materialization settings

4. **Analyze the query** -- Use `sql_analyze` with the detected `dialect` to check for anti-patterns and `lineage_check` to understand column flow

5. **Inspect the schema** -- Use `schema_inspect` to understand column types, especially timestamp columns suitable for `event_time` or incremental filtering

6. **Choose the strategy** -- Select the right incremental approach based on:
   - The warehouse adapter (see Strategy Support Matrix below)
   - The data pattern (append-only vs mutable vs partitioned)
   - Table size and query performance requirements
   - See `references/` for warehouse-specific guidance

7. **Generate the incremental version** -- Rewrite the model with proper `is_incremental()` logic

8. **Update config** -- Add `unique_key`, `on_schema_change`, strategy settings, and any adapter-specific config

## Strategy Support Matrix

| Strategy | Snowflake | BigQuery | Databricks | Postgres | Redshift | Spark |
|----------|-----------|----------|------------|----------|----------|-------|
| `append` | Yes | Yes | Yes | Yes | Yes | Yes |
| `merge` | Yes | Yes | Yes | Yes | Yes | Yes |
| `delete+insert` | Yes | Yes | Yes | Yes | Yes | Yes |
| `insert_overwrite` | Yes | No | Yes | Yes | Yes | Yes |
| `microbatch` | Yes | Yes* | Yes | Yes* | Yes* | Yes* |

*Microbatch is a **dbt-core feature since v1.9** (not Snowflake-only). Adapter-specific notes:
- **Postgres**: requires `unique_key`
- **BigQuery/Spark**: require `partition_by`
- **Snowflake/Databricks**: support parallel batch execution via `concurrent_batches`

## Strategy Selection Guide

| Data Pattern | Recommended Strategy | When to Use |
|-------------|---------------------|-------------|
| Immutable event streams | `append` | Rows never change after creation (logs, clicks, IoT) |
| Mutable records, small-medium tables | `merge` | Records update (orders, customers). Tables under ~100M rows |
| Mutable records, large tables | `delete+insert` | Same as merge but better performance on 100M+ row tables |
| Date-partitioned facts | `insert_overwrite` | Full partition replacement. Best for BigQuery/Databricks partitioned tables |
| Large time-series, controlled batching | `microbatch` | Need automatic time-based batching with late-arrival handling |

## Core Patterns

### Append-Only (Event Logs)
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
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
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

### Delete+Insert (Large Mutable Tables)
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='delete+insert',
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

### Insert Overwrite (Partitioned Facts)
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

### Microbatch (Time-Series Batching)
Available on all major adapters since dbt-core v1.9.
```sql
{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    event_time='created_at',
    begin='2024-01-01',
    batch_size='day',
    lookback=1
) }}

select * from {{ ref('stg_events') }}
```
No `is_incremental()` block needed -- dbt handles time filtering automatically per batch.

## Common Pitfalls

| Issue | Problem | Fix |
|-------|---------|-----|
| Missing `unique_key` | Duplicates on re-run | Add `unique_key` matching the primary/natural key |
| Wrong timestamp column | Missed updates | Use `updated_at` (not `created_at`) for mutable data |
| No lookback window | Late-arriving data missed | Use `max(ts) - interval '1 hour'` instead of strict `>` |
| `on_schema_change='fail'` | Breaks on column additions | Use `'append_new_columns'` or `'sync_all_columns'` |
| Null unique_key values | Rows fail to match, causing duplicates | Ensure unique_key columns never contain nulls |
| Merge on 100M+ rows | Slow performance, timeouts | Switch to `delete+insert` or `insert_overwrite` |
| Missing `--full-refresh` plan | Schema drift accumulates silently | Schedule periodic `dbt run --full-refresh -s model_name` |
| `{{ this }}` on first run | Query fails | `is_incremental()` returns false on first run -- outer query runs unfiltered |

## Usage

- `/incremental-logic models/marts/fct_orders.sql` -- Convert to incremental
- `/incremental-logic fix models/marts/fct_orders.sql` -- Fix existing incremental logic
- `/incremental-logic strategy orders` -- Recommend best strategy for a table

Use the tools: `warehouse_list`, `dbt_profiles`, `dbt_manifest`, `glob`, `read`, `sql_analyze`, `lineage_check`, `schema_inspect`, `edit`, `write`.
