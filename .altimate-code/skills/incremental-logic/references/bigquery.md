# BigQuery Incremental Strategies

## Supported Strategies
`append`, `merge`, `delete+insert`, `microbatch`

BigQuery does **not** support `insert_overwrite`.

## Default Strategy
`merge`

## BigQuery-Specific Config

### Partition By (Critical)
BigQuery performance depends heavily on partition pruning:
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    partition_by={
        'field': 'order_date',
        'data_type': 'date',
        'granularity': 'day'
    }
) }}
```

Partition granularity options: `hour`, `day`, `month`, `year`

For integer-range partitioning:
```sql
partition_by={
    'field': 'user_id',
    'data_type': 'int64',
    'range': {'start': 0, 'end': 1000000, 'interval': 1000}
}
```

### Clustering
BigQuery supports up to 4 clustering columns:
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    partition_by={'field': 'order_date', 'data_type': 'date'},
    cluster_by=['customer_id', 'status']
) }}
```
Place the most-filtered column first.

### Incremental Predicates
Limit the merge scan window:
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    partition_by={'field': 'order_date', 'data_type': 'date'},
    incremental_predicates=[
        "DBT_INTERNAL_DEST.order_date >= date_sub(current_date(), interval 7 day)"
    ]
) }}
```

### Microbatch on BigQuery
Requires `partition_by`:
```sql
{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    event_time='created_at',
    begin='2024-01-01',
    batch_size='day',
    partition_by={'field': 'created_at', 'data_type': 'timestamp', 'granularity': 'day'}
) }}
```

### Require Partition Filter
Prevent full table scans in downstream queries:
```sql
{{ config(
    materialized='incremental',
    partition_by={'field': 'event_date', 'data_type': 'date'},
    require_partition_filter=true
) }}
```

## Performance Tips
- Always partition incremental tables -- unpartitioned merges on 500M+ rows are extremely slow
- Merge performance degrades past ~100M rows; consider `delete+insert` for large tables
- Use `incremental_predicates` to limit the merge scan to recent partitions
- Cluster on high-cardinality filter columns after the partition column
- BigQuery charges by bytes scanned -- partition pruning directly reduces cost
- Use `copy_partitions=true` with `insert_overwrite` when available via custom macros
