---
name: medallion-patterns
description: Apply medallion architecture (bronze/silver/gold) patterns to organize dbt models into clean data layers.
---

# Medallion Architecture Patterns

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** glob, read, dbt_manifest, dbt_run, write, edit

Guide and scaffold dbt projects following the medallion (bronze/silver/gold) architecture pattern.

## Workflow

1. **Audit current structure** — Use `glob` to scan the project's `models/` directory and `dbt_manifest` to understand existing organization
2. **Identify the current state** — Classify existing models into medallion layers based on naming and content
3. **Recommend reorganization** — Suggest how to reorganize models into proper layers
4. **Scaffold missing layers** — Create directory structure and template models for gaps

## Medallion Layer Definitions

### Bronze (Raw / Staging)
**Purpose**: Ingest raw data with minimal transformation. Preserve source fidelity.

```
models/
  bronze/
    source_system/
      _source_system__sources.yml
      brz_source_system__table.sql
```

**Pattern**:
```sql
-- brz_stripe__payments.sql
{{ config(materialized='view') }}

with source as (
    select * from {{ source('stripe', 'payments') }}
),

cast as (
    select
        cast(id as varchar) as payment_id,
        cast(amount as integer) as amount_cents,
        cast(created as timestamp) as created_at,
        _loaded_at  -- preserve load metadata
    from source
)

select * from cast
```

**Rules**:
- 1:1 mapping with source tables
- Only type casting, renaming, deduplication
- No joins, no business logic
- Materialized as `view` or `ephemeral`
- Naming: `brz_<source>__<table>`

### Silver (Cleaned / Intermediate)
**Purpose**: Business-conformant data. Joins, deduplication, standardization.

```
models/
  silver/
    domain/
      slv_domain__entity.sql
```

**Pattern**:
```sql
-- slv_finance__orders_enriched.sql
{{ config(materialized='table') }}

with orders as (
    select * from {{ ref('brz_stripe__payments') }}
),

customers as (
    select * from {{ ref('brz_crm__customers') }}
),

enriched as (
    select
        o.payment_id,
        o.amount_cents / 100.0 as amount_dollars,
        c.customer_name,
        c.segment,
        o.created_at
    from orders o
    left join customers c on o.customer_id = c.customer_id
    where o.created_at is not null  -- quality filter
)

select * from enriched
```

**Rules**:
- Cross-source joins allowed
- Business logic transformations
- Data quality filters (remove nulls, duplicates)
- Standardized naming conventions
- Materialized as `table` or `incremental`
- Naming: `slv_<domain>__<entity>`

### Gold (Business / Marts)
**Purpose**: Business-ready aggregations and metrics. Direct consumption by BI/analytics.

```
models/
  gold/
    domain/
      fct_metric.sql
      dim_entity.sql
```

**Pattern**:
```sql
-- fct_daily_revenue.sql
{{ config(
    materialized='incremental',
    unique_key='revenue_date',
    on_schema_change='append_new_columns'
) }}

with orders as (
    select * from {{ ref('slv_finance__orders_enriched') }}
    {% if is_incremental() %}
    where created_at > (select max(revenue_date) from {{ this }})
    {% endif %}
),

daily as (
    select
        date_trunc('day', created_at) as revenue_date,
        segment,
        count(*) as order_count,
        sum(amount_dollars) as gross_revenue
    from orders
    group by 1, 2
)

select * from daily
```

**Rules**:
- Aggregations, metrics, KPIs
- Wide denormalized tables for BI
- Fact tables (`fct_`) and dimension tables (`dim_`)
- Materialized as `table` or `incremental`
- Naming: `fct_<metric>` or `dim_<entity>`

## Migration Checklist

When reorganizing an existing project:

1. Create the directory structure (`bronze/`, `silver/`, `gold/`)
2. Map existing `stg_` models → `bronze/` layer
3. Map existing `int_` models → `silver/` layer
4. Map existing `fct_`/`dim_` models → `gold/` layer
5. Update `dbt_project.yml` with layer-specific materializations:
```yaml
models:
  my_project:
    bronze:
      +materialized: view
    silver:
      +materialized: table
    gold:
      +materialized: incremental
```
6. Update all `ref()` calls to match new model names
7. Run `dbt build` to verify no breakages

## Usage

- `/medallion-patterns audit` — Analyze current project structure
- `/medallion-patterns scaffold stripe` — Create bronze/silver/gold for a new source
- `/medallion-patterns migrate` — Plan migration of existing stg/int/mart to medallion

Use the tools: `glob`, `read`, `dbt_manifest`, `dbt_run`, `write`, `edit`.
