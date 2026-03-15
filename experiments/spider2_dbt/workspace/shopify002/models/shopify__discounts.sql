with discount_code as (

    select *
    from {{ var('shopify_discount_code') }}

), price_rule as (

    select *
    from {{ var('shopify_price_rule') }}

), order_aggregates as (

    -- aggregated by (code, type, source_relation) in the intermediate model
    select *
    from {{ ref('int_shopify__discounts__order_aggregates') }}

), abandoned_checkout_aggregates as (

    -- aggregated by (code, type, source_relation) in the intermediate model
    select *
    from {{ ref('int_shopify__discounts__abandoned_checkouts') }}

), order_agg_combined as (

    -- sum across types (shipping, percentage, fixed_amount) per code + source_relation
    select
        code,
        source_relation,
        sum(total_order_discount_amount) as total_order_discount_amount,
        sum(total_order_line_items_price) as total_order_line_items_price,
        sum(total_order_shipping_cost) as total_order_shipping_cost,
        sum(total_order_refund_amount) as total_order_refund_amount,
        sum(count_orders) as count_orders,
        sum(count_customers) as count_customers,
        sum(count_customer_emails) as count_customer_emails,
        avg(avg_order_discount_amount) as avg_order_discount_amount

    from order_aggregates
    group by 1, 2

), abandoned_agg_combined as (

    -- sum across types per code + source_relation
    select
        code,
        source_relation,
        sum(total_abandoned_checkout_discount_amount) as total_abandoned_checkout_discount_amount,
        sum(total_abandoned_checkout_shipping_price) as total_abandoned_checkout_shipping_price,
        sum(count_abandoned_checkouts) as count_abandoned_checkouts,
        sum(count_abandoned_checkout_customers) as count_abandoned_checkout_customers,
        sum(count_abandoned_checkout_customer_emails) as count_abandoned_checkout_customer_emails

    from abandoned_checkout_aggregates
    group by 1, 2

), joined as (

    select
        -- discount code fields
        {{ dbt_utils.generate_surrogate_key(['discount_code.discount_code_id', 'discount_code.source_relation']) }} as discounts_unique_key,
        discount_code.discount_code_id,
        discount_code.code,
        discount_code.price_rule_id,
        discount_code.usage_count,
        discount_code.created_at,
        discount_code.updated_at,
        discount_code._fivetran_synced,
        discount_code.source_relation,

        -- price rule fields
        price_rule.title,
        price_rule.allocation_limit,
        price_rule.allocation_method,
        price_rule.customer_selection,
        price_rule.is_once_per_customer,
        price_rule.prereq_min_quantity,
        price_rule.prereq_max_shipping_price,
        price_rule.prereq_min_subtotal,
        price_rule.prereq_min_purchase_quantity_for_entitlement,
        price_rule.prereq_buy_x_get_this,
        price_rule.prereq_buy_this_get_y,
        price_rule.target_selection,
        price_rule.target_type,
        price_rule.value,
        price_rule.value_type,
        price_rule.starts_at,
        price_rule.ends_at,
        price_rule.usage_limit,
        price_rule.created_at as price_rule_created_at,
        price_rule.updated_at as price_rule_updated_at,

        -- order aggregate metrics
        order_agg_combined.total_order_discount_amount,
        order_agg_combined.total_order_line_items_price,
        order_agg_combined.total_order_shipping_cost,
        order_agg_combined.total_order_refund_amount,
        order_agg_combined.count_orders,
        order_agg_combined.count_customers,
        order_agg_combined.count_customer_emails,
        order_agg_combined.avg_order_discount_amount,

        -- abandoned checkout aggregate metrics
        abandoned_agg_combined.total_abandoned_checkout_discount_amount,
        abandoned_agg_combined.total_abandoned_checkout_shipping_price,
        abandoned_agg_combined.count_abandoned_checkouts,
        abandoned_agg_combined.count_abandoned_checkout_customers,
        abandoned_agg_combined.count_abandoned_checkout_customer_emails

    from discount_code
    left join price_rule
        on discount_code.price_rule_id = price_rule.price_rule_id
        and discount_code.source_relation = price_rule.source_relation
    left join order_agg_combined
        on discount_code.code = order_agg_combined.code
        and discount_code.source_relation = order_agg_combined.source_relation
    left join abandoned_agg_combined
        on discount_code.code = abandoned_agg_combined.code
        and discount_code.source_relation = abandoned_agg_combined.source_relation

)

select *
from joined
