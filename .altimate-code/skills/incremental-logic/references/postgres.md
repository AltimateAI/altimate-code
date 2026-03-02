# PostgreSQL Incremental Strategies

## Supported Strategies
`append`, `merge`, `delete+insert`, `insert_overwrite`, `microbatch`

## Default Strategy
`append`

## PostgreSQL-Specific Config

### Merge Support
PostgreSQL 15+ supports native MERGE. For older versions, dbt falls back to `delete+insert`.
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge'
) }}
```

### Delete+Insert (Preferred for Mutable Data)
The most reliable strategy for mutable records on PostgreSQL:
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
    updated_at
from {{ ref('stg_orders') }}

{% if is_incremental() %}
where updated_at > (select max(updated_at) from {{ this }})
{% endif %}
```

### Microbatch on PostgreSQL
Requires `unique_key` (unlike other adapters):
```sql
{{ config(
    materialized='incremental',
    incremental_strategy='microbatch',
    unique_key='event_id',
    event_time='created_at',
    begin='2024-01-01',
    batch_size='day'
) }}
```

### Indexing for Performance
PostgreSQL benefits from indexes on incremental filter columns. Add post-hooks:
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='delete+insert',
    post_hook=[
        "CREATE INDEX IF NOT EXISTS idx_{{ this.name }}_updated_at ON {{ this }} (updated_at)"
    ]
) }}
```

## Performance Tips
- Prefer `delete+insert` over `merge` for reliability across PostgreSQL versions
- Add indexes on the timestamp column used in `is_incremental()` filters
- Run `VACUUM ANALYZE` periodically on incremental tables (or use autovacuum)
- PostgreSQL does not have native partitioning in dbt -- use `insert_overwrite` with caution
- For large tables, consider PostgreSQL native partitioning with `{{ config(pre_hook="...") }}`
- Keep `unique_key` columns indexed for fast delete operations
