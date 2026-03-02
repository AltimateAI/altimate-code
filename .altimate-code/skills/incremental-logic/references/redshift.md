# Redshift Incremental Strategies

## Supported Strategies
`append`, `merge`, `delete+insert`, `insert_overwrite`, `microbatch`

## Default Strategy
`append`

## Redshift-Specific Config

### Distribution and Sort Keys
Critical for incremental performance on Redshift:
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='delete+insert',
    dist='order_id',
    sort=['order_date', 'customer_id'],
    sort_type='compound'
) }}
```

### Delete+Insert (Recommended)
Redshift historically lacked native MERGE. `delete+insert` is the most battle-tested strategy:
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

### Merge on Redshift
Redshift Serverless and newer Redshift versions support MERGE natively. Older provisioned clusters use a `delete+insert` fallback:
```sql
{{ config(
    materialized='incremental',
    unique_key='order_id',
    incremental_strategy='merge'
) }}
```

## Performance Tips
- Use `delete+insert` as the default -- it is the most reliable strategy on Redshift
- Set `dist` key to the join/unique key column for collocated deletes
- Set `sort` key to the timestamp column used in `is_incremental()` for zone-map pruning
- Compound sort keys work best when the first column is the incremental filter
- Run `VACUUM` and `ANALYZE` after large incremental loads
- Avoid `merge` on provisioned Redshift clusters without native MERGE support
- Use `bind_type='compound'` (default) for sort keys used in range filters
