{{
    config(
        materialized='table' if target.type in ('bigquery', 'databricks', 'spark') else 'incremental',
        unique_key='discounts_unique_key',
        incremental_strategy='delete+insert' if target.type in ('postgres', 'redshift', 'snowflake') else 'merge',
        cluster_by=['discount_code_id']
        ) 
}}

with discount as (

    select 
        *,
        {{ dbt_utils.generate_surrogate_key(['source_relation', 'discount_code_id']) }} as discounts_unique_key
    from {{ var('shopify_discount_code') }}

    {% if is_incremental() %}
    where cast(coalesce(updated_at, created_at) as date) >= {{ shopify.shopify_lookback(
        from_date="max(cast(coalesce(updated_at, created_at) as date))", 
        interval=var('lookback_window', 7), 
        datepart='day') }}
    {% endif %}
),

price_rule as (

    select *
    from {{ var('shopify_price_rule') }}
),

orders_aggregated as (

    select *
    from {{ ref('int_shopify__discounts__order_aggregates')}}
),

abandoned_checkouts_aggregated as (

    select *
    from {{ ref('int_shopify__discounts__abandoned_checkouts')}}
),

discount_price_rule_joined as (

    select
        discount.*,
        price_rule.target_selection,
        price_rule.target_type,
        price_rule.title,
        price_rule.usage_limit,
        price_rule.value,
        price_rule.value_type,
        price_rule.allocation_limit,
        price_rule.allocation_method,
        price_rule.is_once_per_customer,
        price_rule.customer_selection,
        -- the below are NULL if customer_selection = all
        price_rule.prereq_min_quantity,
        price_rule.prereq_max_shipping_price,
        price_rule.prereq_min_subtotal,
        price_rule.prereq_min_purchase_quantity_for_entitlement,
        price_rule.prereq_buy_x_get_this,
        price_rule.prereq_buy_this_get_y,
        price_rule.starts_at,
        price_rule.ends_at,
        price_rule.created_at as price_rule_created_at,
        price_rule.updated_at as price_rule_updated_at

    from discount
    left join price_rule
        on discount.price_rule_id = price_rule.price_rule_id
        and discount.source_relation = price_rule.source_relation
),

aggregates_joined as (

    select 
        discount_price_rule_joined.*,
        coalesce(orders_aggregated.count_orders, 0) as count_orders,
        coalesce(abandoned_checkouts_aggregated.count_abandoned_checkouts, 0) as count_abandoned_checkouts,
        orders_aggregated.avg_order_discount_amount,
        coalesce(orders_aggregated.total_order_discount_amount, 0) as total_order_discount_amount,
        coalesce(abandoned_checkouts_aggregated.total_abandoned_checkout_discount_amount, 0) as total_abandoned_checkout_discount_amount,
        coalesce(orders_aggregated.total_order_line_items_price, 0) as total_order_line_items_price,
        coalesce(orders_aggregated.total_order_shipping_cost, 0) as total_order_shipping_cost,
        coalesce(abandoned_checkouts_aggregated.total_abandoned_checkout_shipping_price, 0) as total_abandoned_checkout_shipping_price,
        coalesce(orders_aggregated.total_order_refund_amount, 0) as total_order_refund_amount,
        coalesce(orders_aggregated.count_customers, 0) as count_customers,
        coalesce(orders_aggregated.count_customer_emails, 0) as count_customer_emails,
        coalesce(abandoned_checkouts_aggregated.count_abandoned_checkout_customers, 0) as count_abandoned_checkout_customers,
        coalesce(abandoned_checkouts_aggregated.count_abandoned_checkout_customer_emails, 0) as count_abandoned_checkout_customer_emails

    from discount_price_rule_joined
    left join orders_aggregated
        on discount_price_rule_joined.code = orders_aggregated.code
        and discount_price_rule_joined.source_relation = orders_aggregated.source_relation
        -- in case one CODE can apply to both shipping and line items, percentages and fixed_amounts
        and (case 
                when discount_price_rule_joined.target_type = 'shipping_line' then 'shipping' -- when target_type = 'shipping', value_type = 'percentage'
                else discount_price_rule_joined.value_type end) = orders_aggregated.type
        
    left join abandoned_checkouts_aggregated
        on discount_price_rule_joined.code = abandoned_checkouts_aggregated.code
        and discount_price_rule_joined.source_relation = abandoned_checkouts_aggregated.source_relation
        -- in case one CODE can apply to both shipping and line items, percentages and fixed_amounts
        and (case 
                when discount_price_rule_joined.target_type = 'shipping_line' then 'shipping' -- when target_type = 'shipping', value_type = 'percentage'
                else discount_price_rule_joined.value_type end) = abandoned_checkouts_aggregated.type 
)

select * 
from aggregates_joined