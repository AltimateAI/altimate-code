# Snowflake dbt Materializations

## Table Types
- **Permanent tables**: Default `table` materialization. Persists with Time Travel and Fail-safe.
- **Transient tables**: `{{ config(transient=true) }}` -- No Fail-safe, lower storage cost. Use for intermediate/staging tables that can be rebuilt.
- **Views**: Zero storage cost, always fresh. Use for staging layer.

## Dynamic Tables
Snowflake-managed incremental refresh (alternative to dbt incremental):
```sql
CREATE DYNAMIC TABLE ... TARGET_LAG = '1 hour' AS SELECT ...
```
- Snowflake handles incremental logic automatically
- Not directly supported as a dbt materialization; use dbt incremental instead
- Consider for non-dbt pipelines feeding into dbt sources

## Clustering
Apply clustering to large mart tables (1TB+) for query performance:
```sql
{{ config(
    materialized='table',
    cluster_by=['order_date', 'customer_id']
) }}
```
- Cluster on columns used in WHERE and JOIN predicates
- Timestamp + high-cardinality dimension is the typical pattern
- Avoid clustering staging views (no benefit)

## Materialization Defaults by Layer

| Layer | Materialization | Config |
|-------|----------------|--------|
| Staging | `view` | Default, no extra config needed |
| Intermediate | `ephemeral` or `view` | `ephemeral` if only used by downstream models |
| Mart (small) | `table` | Add `transient=true` for non-critical marts |
| Mart (large) | `incremental` | `merge` strategy, add `cluster_by` for 1TB+ tables |

## Snowflake-Specific Config Options
- `query_tag`: Tag queries for cost attribution: `{{ config(query_tag='team=analytics') }}`
- `warehouse`: Override warehouse per model: `{{ config(snowflake_warehouse='TRANSFORM_WH') }}`
- `copy_grants`: Preserve grants on table rebuild: `{{ config(copy_grants=true) }}`
- `secure`: Create secure views: `{{ config(secure=true) }}`
