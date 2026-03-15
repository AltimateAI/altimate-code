{{ config(
    tags="fivetran_validations",
    enabled=var('fivetran_validation_tests_enabled', false)
) }}

with orders as (

    select *
    from {{ ref('shopify__orders') }}
),

order_metrics as (

    select 
        source_relation,
        cast({{ dbt.date_trunc('day','created_timestamp') }} as date) as date_day,
        count(distinct order_id) as count_orders,
        sum(order_adjusted_total) as order_adjusted_total

    from orders
    where created_timestamp > '2020-01-01' and created_timestamp < '2024-06-10'
    group by 1,2
),

daily_shop as (

    select *
    from {{ ref('shopify__daily_shop') }}
),

daily_shop_metrics as (

    select 
        source_relation,
        date_day,
        sum(count_orders) as count_orders,
        sum(order_adjusted_total) as order_adjusted_total

    from daily_shop
    where date_day >= '2020-01-01' and date_day < '2024-06-10'
    group by 1,2
),

final as (

    select
        daily_shop_metrics.source_relation,
        coalesce(daily_shop_metrics.count_orders, 0) as daily_shop_count_orders,
        coalesce(order_metrics.count_orders, 0) as order_count_orders,
        coalesce(daily_shop_metrics.order_adjusted_total, 0) as daily_shop_order_adjusted_total,
        coalesce(order_metrics.order_adjusted_total, 0) as order_order_adjusted_total

    from daily_shop_metrics
    full outer join order_metrics
        on daily_shop_metrics.source_relation = order_metrics.source_relation
        and daily_shop_metrics.date_day = order_metrics.date_day
)

select *
from final
where 
    abs(daily_shop_count_orders - order_count_orders) > 0 or
    abs(daily_shop_order_adjusted_total - order_order_adjusted_total) > .1