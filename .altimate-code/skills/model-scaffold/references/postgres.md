# PostgreSQL dbt Materializations

## Table Materializations
PostgreSQL supports standard dbt materializations with some adapter-specific options:
- **table**: `CREATE TABLE AS SELECT` -- full rebuild each run
- **view**: `CREATE VIEW` -- zero storage, always fresh, best for staging
- **incremental**: Supports `append`, `merge` (PG 15+), and `delete+insert` strategies
- **ephemeral**: Compiled as CTE inline; no database object created

## Indexes
PostgreSQL is row-oriented -- indexes are critical for query performance on mart tables:
```sql
{{ config(
    materialized='table',
    indexes=[
        {'columns': ['customer_id'], 'type': 'btree'},
        {'columns': ['created_at'], 'type': 'btree'},
        {'columns': ['metadata'], 'type': 'gin'}
    ]
) }}
```
- B-tree for equality/range filters (most common)
- GIN for JSONB and array columns
- dbt creates indexes after table rebuild automatically

## Table Partitioning
Declarative partitioning for large tables (100M+ rows):
- Not directly in dbt config; use post-hook or manual DDL
- Partition by range (dates) or list (categories)

## Materialized Views
PostgreSQL materialized views require manual refresh:
- Not auto-refreshed; schedule via dbt post-hook or cron
- `CONCURRENTLY` refresh avoids locks (requires unique index)
- Best for expensive aggregations queried frequently

## Unlogged Tables
Skip WAL for faster writes on rebuildable tables:
```sql
{{ config(materialized='table', unlogged=true) }}
```
- Data lost on crash/failover; only use for staging/intermediate

## Materialization Defaults by Layer

| Layer | Materialization | Config |
|-------|----------------|--------|
| Staging | `view` | No storage, always fresh |
| Intermediate | `ephemeral` or `view` | Ephemeral preferred unless debugging |
| Mart (small) | `table` | Add indexes on filter/join columns |
| Mart (large) | `incremental` | `delete+insert` strategy (merge requires PG 15+) |

## PostgreSQL-Specific Config Options
- `indexes`: Define B-tree, GIN, GiST, BRIN indexes on rebuild
- `unlogged`: Skip WAL for faster writes on rebuildable tables
