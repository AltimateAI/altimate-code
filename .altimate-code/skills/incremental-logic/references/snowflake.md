# Snowflake Incremental Strategies

## Supported Strategies
All five strategies: `append`, `merge`, `delete+insert`, `insert_overwrite`, `microbatch`

## Default Strategy
`merge`

## Snowflake-Specific Config

### Cluster Keys
Snowflake uses automatic micro-partitioning but supports explicit clustering:
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    cluster_by=['order_date']
) }}
```
Cluster on the column used in your `is_incremental()` filter for best partition pruning.

### Incremental Predicates
Limit the merge scan window for large tables:
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    incremental_predicates=[
        "DBT_INTERNAL_DEST.order_date >= dateadd(day, -7, current_date)"
    ]
) }}
```

### Merge Behavior
- Snowflake MERGE is atomic and supports multi-column unique keys
- `merge_update_columns` limits which columns get updated (reduces write amplification)
- `merge_exclude_columns` is the inverse -- update everything except listed columns

### Microbatch on Snowflake
Snowflake supports parallel batch execution:
```sql
{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    event_time='created_at',
    begin='2024-01-01',
    batch_size='day',
    lookback=1,
    concurrent_batches=true
) }}
```

### Insert Overwrite
Snowflake does not have native partitions, but `insert_overwrite` uses a temp table + swap approach:
```sql
{{ config(
    materialized='incremental',
    incremental_strategy='insert_overwrite',
    partition_by=['date_trunc(day, event_time)']
) }}
```

## Performance Tips
- Use `delete+insert` over `merge` for tables exceeding 100M rows
- Add `incremental_predicates` to limit merge scan window on large tables
- Cluster on the incremental filter column (typically a timestamp)
- Set `merge_update_columns` to avoid rewriting unchanged columns
- Schedule periodic `--full-refresh` to compact micro-partitions
