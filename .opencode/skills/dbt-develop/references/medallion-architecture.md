# Medallion Architecture (Bronze / Silver / Gold)

An alternative to staging/intermediate/mart layering. Common in Databricks and lakehouse environments.

## Layer Mapping

| Medallion | Traditional dbt | Purpose |
|-----------|----------------|---------|
| Bronze | Staging (`stg_`) | Raw ingestion, minimal transform |
| Silver | Intermediate (`int_`) | Cleaned, conformed, joined |
| Gold | Marts (`fct_`/`dim_`) | Business-ready aggregations |

## Directory Structure

```
models/
  bronze/
    source_system/
      _source_system__sources.yml
      brz_source_system__table.sql
  silver/
    domain/
      slv_domain__entity.sql
  gold/
    domain/
      fct_metric.sql
      dim_entity.sql
```

## Bronze (Raw)

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
        _loaded_at
    from source
)

select * from cast
```

**Rules**: 1:1 with source, only cast/rename, no joins, `view` materialization.

## Silver (Cleaned)

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
    where o.created_at is not null
)

select * from enriched
```

**Rules**: Cross-source joins, business logic, quality filters, `table` materialization.

## Gold (Business-Ready)

```sql
-- fct_daily_revenue.sql
{{ config(materialized='table') }}

with daily as (
    select
        date_trunc('day', created_at) as revenue_date,
        segment,
        count(*) as order_count,
        sum(amount_dollars) as gross_revenue
    from {{ ref('slv_finance__orders_enriched') }}
    group by 1, 2
)

select * from daily
```

**Rules**: Aggregations, metrics, KPIs, `table` or `incremental` materialization.

## dbt_project.yml Config

```yaml
models:
  my_project:
    bronze:
      +materialized: view
    silver:
      +materialized: table
    gold:
      +materialized: table
```

## When to Use Medallion vs Traditional

| Use Medallion When | Use Traditional When |
|-------------------|---------------------|
| Databricks/lakehouse environment | dbt Cloud or Snowflake-centric |
| Team already uses bronze/silver/gold terminology | Team uses staging/intermediate/mart |
| Data platform team maintains bronze layer | Analytics engineers own the full stack |
