# Incremental Materialization Strategies

## When to Use Incremental

Use incremental when:
- Table has millions+ rows
- Source data is append-only or has reliable `updated_at` timestamps
- Full refreshes take too long or cost too much

Do NOT use incremental when:
- Table is small (< 1M rows)
- Source data doesn't have reliable timestamps
- Logic requires full-table window functions

## Strategy Decision Tree

```
Is the data append-only (events, logs)?
  YES → Append strategy
  NO → Can rows be updated?
    YES → Does your warehouse support MERGE?
      YES → Merge/Upsert strategy
      NO → Delete+Insert strategy
    NO → Is data date-partitioned?
      YES → Insert Overwrite strategy
      NO → Append with dedup
```

## Append (Event Logs)

```sql
{{ config(
    materialized='incremental',
    on_schema_change='append_new_columns'
) }}

select
    event_id,
    event_type,
    created_at
from {{ ref('stg_events') }}

{% if is_incremental() %}
where created_at > (select max(created_at) from {{ this }})
{% endif %}
```

## Merge/Upsert (Mutable Records)

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

## Insert Overwrite (Partitioned)

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

## Common Pitfalls

| Issue | Problem | Fix |
|-------|---------|-----|
| Missing `unique_key` | Duplicates on re-run | Add `unique_key` matching the primary key |
| Wrong timestamp column | Missed updates | Use `updated_at` not `created_at` for mutable data |
| No lookback window | Late-arriving data missed | `max(ts) - interval '1 hour'` instead of strict `>` |
| `on_schema_change='fail'` | Breaks on column additions | Use `'append_new_columns'` or `'sync_all_columns'` |
| Full refresh needed | Schema drift accumulated | `altimate-dbt run --model <name>` with `--full-refresh` flag |

## Official Documentation

For the latest syntax and adapter-specific options, refer to:
- **dbt incremental models**: https://docs.getdbt.com/docs/build/incremental-models
- **Incremental strategies by adapter**: https://docs.getdbt.com/docs/build/incremental-strategy
- **Configuring incremental models**: https://docs.getdbt.com/reference/resource-configs/materialized#incremental

## Warehouse Support

| Warehouse | Default Strategy | Merge | Partition | Notes |
|-----------|-----------------|-------|-----------|-------|
| Snowflake | `merge` | Yes | Cluster keys | Best incremental support |
| BigQuery | `merge` | Yes | `partition_by` | Requires partition for insert_overwrite |
| PostgreSQL | `append` | No | No | Use delete+insert pattern |
| DuckDB | `append` | Partial | No | Limited incremental support |
| Redshift | `append` | No | dist/sort keys | Use delete+insert pattern |
