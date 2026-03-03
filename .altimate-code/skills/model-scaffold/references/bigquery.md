# BigQuery dbt Materializations

## Partitioned Tables
BigQuery tables should almost always be partitioned for cost and performance:
```sql
{{ config(
    materialized='table',
    partition_by={
        'field': 'event_date',
        'data_type': 'date',
        'granularity': 'day'
    }
) }}
```
- Partition on date/timestamp columns used in WHERE filters
- Granularity options: `hour`, `day`, `month`, `year`
- Integer-range partitioning available for non-date columns
- Require partition filters: `require_partition_filter=true` prevents full scans

## Clustering
Cluster within partitions for further pruning (up to 4 columns):
```sql
{{ config(
    materialized='table',
    partition_by={'field': 'created_date', 'data_type': 'date'},
    cluster_by=['customer_id', 'product_category']
) }}
```
- Order columns low-to-high cardinality for best pruning
- BigQuery auto-re-clusters; no maintenance needed

## Materialized Views
BigQuery materialized views auto-refresh and are used transparently by the query optimizer:
- Best for pre-aggregated dashboard queries
- dbt supports them: `{{ config(materialized='materialized_view') }}`
- Cannot contain JOINs, subqueries, or non-deterministic functions

## Table Expiration
Set expiration for temporary or staging tables:
```sql
{{ config(
    materialized='table',
    hours_to_expiration=24
) }}
```

## Materialization Defaults by Layer

| Layer | Materialization | Config |
|-------|----------------|--------|
| Staging | `view` | No storage cost, always fresh |
| Intermediate | `ephemeral` | Compiled as CTE, no BigQuery object created |
| Mart (small) | `table` | Add `partition_by` on date column |
| Mart (large) | `incremental` | `merge` or `insert_overwrite` with `partition_by` |

## BigQuery-Specific Config Options
- `labels`: Cost attribution: `{{ config(labels={'team': 'analytics'}) }}`
- `kms_key_name`: Customer-managed encryption key
- `grant_access_to`: Share with other datasets
- `enable_list_inference`: Improve performance for repeated fields
