# dbt Layer Patterns

## Staging (`stg_`)

**Purpose**: 1:1 with source table. Rename, cast, no joins, no business logic.
**Materialization**: `view`
**Naming**: `stg_<source>__<table>.sql`
**Location**: `models/staging/<source>/`

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

**Rules**:
- One CTE named `source`, one named `renamed` (or `cast`, `cleaned`)
- Only type casting, renaming, deduplication
- No joins, no filters (except dedup), no business logic

## Intermediate (`int_`)

**Purpose**: Business logic, joins, transformations between staging and marts.
**Materialization**: `ephemeral` or `view`
**Naming**: `int_<entity>__<verb>.sql` (e.g., `int_orders__joined`, `int_payments__pivoted`)
**Location**: `models/intermediate/`

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

**Rules**:
- Cross-source joins allowed
- Business logic transformations
- Not exposed to end users directly
- Name the verb: `__joined`, `__pivoted`, `__filtered`, `__aggregated`

## Mart: Facts (`fct_`)

**Purpose**: Business events. Immutable, timestamped, narrow.
**Materialization**: `table` or `incremental`
**Naming**: `fct_<entity>.sql`
**Location**: `models/marts/<domain>/`

```sql
with final as (
    select
        order_id,
        customer_id,
        order_date,
        amount,
        discount_amount,
        amount - discount_amount as net_amount
    from {{ ref('int_orders__joined') }}
)

select * from final
```

## Mart: Dimensions (`dim_`)

**Purpose**: Descriptive attributes. Slowly changing, wide.
**Materialization**: `table`
**Naming**: `dim_<entity>.sql`

```sql
with final as (
    select
        customer_id,
        customer_name,
        email,
        segment,
        first_order_date,
        most_recent_order_date,
        lifetime_order_count
    from {{ ref('int_customers__aggregated') }}
)

select * from final
```

## One Big Table (`obt_`)

**Purpose**: Denormalized wide table combining fact + dimensions for BI consumption.
**Materialization**: `table`
**Naming**: `obt_<entity>.sql`

```sql
with facts as (
    select * from {{ ref('fct_orders') }}
),

customers as (
    select * from {{ ref('dim_customers') }}
),

dates as (
    select * from {{ ref('dim_dates') }}
),

final as (
    select
        facts.*,
        customers.customer_name,
        customers.segment,
        dates.day_of_week,
        dates.month_name,
        dates.is_weekend
    from facts
    left join customers on facts.customer_id = customers.customer_id
    left join dates on facts.order_date = dates.date_day
)

select * from final
```

## CTE Style Guide

- Name CTEs after what they contain, not what they do: `orders` not `get_orders`
- Use `final` as the last CTE name
- One CTE per source model (via `ref()` or `source()`)
- End every model with `select * from final`
