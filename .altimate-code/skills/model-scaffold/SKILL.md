---
name: model-scaffold
description: >
  Scaffold a new dbt model following staging/intermediate/mart patterns with proper naming,
  materialization, and structure. Use when the user wants to create a new dbt model, add a
  staging/intermediate/mart layer, scaffold a model from a source table, or set up a new
  dbt model file with the correct naming conventions and project structure.
domain: dbt
persona:
  - analytics-engineer
tools:
  - warehouse_list
  - dbt_profiles
  - glob
  - read
  - schema_inspect
  - schema_search
  - write
docs:
  - title: "dbt Best Practices: How we structure our dbt projects"
    url: "https://docs.getdbt.com/best-practices/how-we-structure/1-guide-overview"
    context: "Staging, intermediate, mart layer conventions, naming, materialization defaults"
  - title: "dbt Style Guide"
    url: "https://docs.getdbt.com/best-practices/how-we-style/0-how-we-style-our-dbt-projects"
    context: "SQL style, CTE naming, model naming conventions"
---

# Scaffold dbt Model

## Requirements
**Agent:** builder or migrator (requires file write access)
**Tools used:** warehouse_list, dbt_profiles, glob, read, schema_inspect, schema_search, write

Generate a new dbt model file following established data modeling patterns. Supports staging, intermediate, and mart layer scaffolding with warehouse-aware materialization defaults.

## Workflow
1. **Detect warehouse** -- Call `warehouse_list` (returns connections with `name`, `type`, `database` — use `type` as the dialect) or `dbt_profiles` (adapter type indicates the warehouse). This determines materialization defaults and SQL dialect.
2. **Determine layer** -- Ask or infer whether this is a staging, intermediate, or mart model based on the user's request.
3. **Read the dbt project** -- Use `glob` to find `dbt_project.yml` and scan the `models/` directory structure. Use `read` on `dbt_project.yml` to understand model paths, naming conventions, and materialization defaults.
4. **Inspect source schema** -- Use `schema_inspect` or `schema_search` to discover source table columns and types.
5. **Generate the model SQL** based on the layer pattern below.
6. **Generate companion YAML** -- Create a `_<directory>__models.yml` (one YAML file per directory) with column descriptions and basic tests. Follow the project's existing YAML organization pattern if one exists.
7. **Write the files** -- Use `write` to create the SQL model and schema YAML in the correct directory.

## Layer Patterns

### Staging (`stg_`)

Staging models are the atomic building blocks of the project. Each staging model has a 1:1 relationship with a source table.

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

| Attribute | Convention |
|-----------|-----------|
| Materialization | `view` (always fresh, lightweight) |
| Naming | `stg_<source>__<table>.sql` (double underscore) |
| Location | `models/staging/<source>/` |
| Purpose | Rename columns, cast types, basic cleaning. No joins, no aggregations. |

### Intermediate (`int_`)

Intermediate models break complex transformations into reusable, purpose-built steps between staging and marts.

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
    left join customers
        on orders.customer_id = customers.customer_id
)

select * from joined
```

| Attribute | Convention |
|-----------|-----------|
| Materialization | `ephemeral` (default) or `view` (if queried directly for debugging) |
| Naming | `int_<entity>__<verb>.sql` (e.g., `int_orders__joined`, `int_payments__pivoted`) |
| Location | `models/intermediate/` or `models/intermediate/<domain>/` |
| Purpose | Joins, filters, pivots, business logic. Multiple inputs allowed, but should serve a single clear purpose. |

### Mart (`fct_` / `dim_`)

Marts are the final business-facing models, organized by domain (e.g., finance, marketing, product).

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

| Attribute | Convention |
|-----------|-----------|
| Materialization | See warehouse defaults below |
| Naming | `fct_<entity>.sql` (facts/events) or `dim_<entity>.sql` (dimensions/entities) |
| Location | `models/marts/<domain>/` |
| Purpose | Business-facing, wide tables, aggregations, final metrics. Named after the entity they represent. |

## Warehouse-Specific Materialization Defaults

Apply these defaults for mart models unless the user specifies otherwise:

| Warehouse | Small marts | Large/append-only marts | Incremental strategy |
|-----------|-------------|------------------------|---------------------|
| Snowflake | `table` | `incremental` | `merge` (default) or `delete+insert` |
| BigQuery | `table` | `incremental` | `merge` or `insert_overwrite` |
| Databricks | `table` | `incremental` | `merge` (Delta) or `append` |
| PostgreSQL | `table` | `incremental` | `delete+insert` |

For incremental marts, always include:
- `unique_key` in the config block
- An `{% if is_incremental() %}` filter on the timestamp column
- `on_schema_change: 'append_new_columns'` for forward compatibility

## Model Governance (dbt Mesh)

When scaffolding models in projects that use dbt Mesh or multi-project setups, include access modifiers in the companion YAML:

| Layer | Default access | When to use `public` |
|-------|---------------|---------------------|
| Staging | `protected` | Never -- staging models are internal building blocks |
| Intermediate | `private` or `protected` | Never -- intermediate models are implementation details |
| Mart | `protected` | When consumed by other dbt projects or BI tools outside the project |

For public mart models, also consider adding `contract: {enforced: true}` with explicit column `data_type` definitions.

## Usage

- `/model-scaffold staging orders from raw.public.orders`
- `/model-scaffold mart fct_daily_revenue`
- `/model-scaffold intermediate int_orders__enriched`
- `/model-scaffold dim_customers from stg_stripe__customers and stg_app__users`

Use the tools: `warehouse_list`, `dbt_profiles`, `glob`, `read`, `schema_inspect`, `schema_search`, `write`.
