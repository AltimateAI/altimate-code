# Databricks Incremental Strategies

## Supported Strategies
All five strategies: `append`, `merge`, `delete+insert`, `insert_overwrite`, `microbatch`

## Default Strategy
`append`

## Databricks-Specific Config

### File Format
Databricks defaults to Delta tables, which enables merge natively:
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    file_format='delta'
) }}
```

### Liquid Clustering (Databricks-specific)
Modern replacement for Z-ordering and OPTIMIZE:
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    liquid_clustered_by=['order_date', 'customer_id']
) }}
```

### Insert Overwrite with Partitions
Databricks supports true partition overwrite on Delta tables:
```sql
{{ config(
    materialized='incremental',
    incremental_strategy='insert_overwrite',
    partition_by=['event_date'],
    file_format='delta'
) }}
```

### Microbatch on Databricks
Supports parallel batch execution:
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

### Incremental Predicates
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge',
    incremental_predicates=[
        "DBT_INTERNAL_DEST.order_date >= dateadd(day, -7, current_date())"
    ]
) }}
```

## Performance Tips
- Use `merge` for Delta tables -- it leverages Delta's built-in MERGE support efficiently
- Prefer `insert_overwrite` for partitioned fact tables (replaces full partitions atomically)
- Use liquid clustering over manual Z-ordering for automatic optimization
- `delete+insert` can outperform `merge` on very large tables (avoids merge join overhead)
- Set `file_format='delta'` explicitly to ensure Delta features are available
- Databricks has a 10,000 file limit per partition -- monitor with `DESCRIBE DETAIL`
