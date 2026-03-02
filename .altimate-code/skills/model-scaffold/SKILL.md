---
name: model-scaffold
description: Scaffold a new dbt model following staging/intermediate/mart patterns with proper naming, materialization, and structure.
---

# Scaffold dbt Model

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** glob, read, dbt_manifest, schema_inspect, schema_search, write

Generate a new dbt model file following established data modeling patterns. Supports staging, intermediate, and mart layer scaffolding.

## Workflow

1. **Determine layer** — Ask or infer whether this is a staging, intermediate, or mart model
2. **Read the dbt project** — Use `glob` to find `dbt_project.yml` and understand the project structure (model paths, naming conventions)
3. **Read the manifest** — If available, use `dbt_manifest` to understand existing models, sources, and dependencies
4. **Inspect source schema** — Use `schema_inspect` or `schema_search` to discover source table columns and types
5. **Generate the model SQL** based on the layer pattern:

### Layer Patterns

#### Staging (`stg_`)
```sql
with source as (
    select * from {{ source('source_name', 'table_name') }}
),

renamed as (
    select
        -- Primary key
        column_id as table_id,

        -- Dimensions
        column_name,

        -- Timestamps
        created_at,
        updated_at

    from source
)

select * from renamed
```
- **Materialization**: `view` (lightweight, always fresh)
- **Naming**: `stg_<source>__<table>.sql`
- **Location**: `models/staging/<source>/`
- **Purpose**: 1:1 with source table, rename columns, cast types, no joins

#### Intermediate (`int_`)
```sql
with orders as (
    select * from {{ ref('stg_source__orders') }}
),

customers as (
    select * from {{ ref('stg_source__customers') }}
),

joined as (
    select
        orders.order_id,
        orders.customer_id,
        customers.customer_name,
        orders.order_date,
        orders.amount
    from orders
    left join customers on orders.customer_id = customers.customer_id
)

select * from joined
```
- **Materialization**: `ephemeral` or `view`
- **Naming**: `int_<entity>__<verb>.sql` (e.g., `int_orders__joined`)
- **Location**: `models/intermediate/`
- **Purpose**: Joins, filters, business logic transformations

#### Mart (`fct_` / `dim_`)
```sql
with final as (
    select
        order_id,
        customer_id,
        order_date,
        amount,
        -- Derived metrics
        sum(amount) over (partition by customer_id) as customer_lifetime_value
    from {{ ref('int_orders__joined') }}
)

select * from final
```
- **Materialization**: `table` or `incremental`
- **Naming**: `fct_<entity>.sql` (facts) or `dim_<entity>.sql` (dimensions)
- **Location**: `models/marts/<domain>/`
- **Purpose**: Business-facing, wide tables, aggregations, final metrics

6. **Generate schema.yml** — Create a companion `_<model_name>__models.yml` with column descriptions and basic tests
7. **Write the files** — Use `write` to create the SQL model and schema YAML

## Usage

- `/model-scaffold staging orders from raw.public.orders`
- `/model-scaffold mart fct_daily_revenue`
- `/model-scaffold intermediate int_orders__enriched`

Use the tools: `glob`, `read`, `dbt_manifest`, `schema_inspect`, `schema_search`, `write`.
