with shop as (

    select *
    from {{ var('shopify_shop') }}
),

calendar as (

    select *
    from {{ ref('shopify__calendar') }}
    where cast({{ dbt.date_trunc('day','date_day') }} as date) = date_day
),

daily_orders as (

    select *
    from {{ ref('int_shopify__daily_orders') }}
),

daily_abandoned_checkouts as (

    select *
    from {{ ref('int_shopify__daily_abandoned_checkouts') }}
),

{% if var('shopify_using_fulfillment_event', false) %}
daily_fulfillment as (

    select *
    from {{ ref('int_shopify__daily_fulfillment') }}
),
{% endif %}

shop_calendar as (

    select
        cast({{ dbt.date_trunc('day','calendar.date_day') }} as date) as date_day,
        shop.shop_id,
        shop.name,
        shop.domain,
        shop.is_deleted,
        shop.currency,
        shop.enabled_presentment_currencies,
        shop.iana_timezone,
        shop.created_at,
        shop.source_relation

    from calendar
    join shop 
        on cast(shop.created_at as date) <= calendar.date_day
),

final as (

    select 
        shop_calendar.*,

        coalesce(daily_orders.count_orders, 0) as count_orders,
        coalesce(daily_orders.count_line_items, 0) as count_line_items,
        daily_orders.avg_line_item_count,
        coalesce(daily_orders.count_customers, 0) as count_customers,
        coalesce(daily_orders.count_customer_emails, 0) as count_customer_emails,
        coalesce(daily_orders.order_adjusted_total, 0) as order_adjusted_total,
        daily_orders.avg_order_value,
        coalesce(daily_orders.shipping_cost, 0) as shipping_cost,
        coalesce(daily_orders.order_adjustment_amount, 0) as order_adjustment_amount,
        coalesce(daily_orders.order_adjustment_tax_amount, 0) as order_adjustment_tax_amount,
        coalesce(daily_orders.refund_subtotal, 0) as refund_subtotal,
        coalesce(daily_orders.refund_total_tax, 0) as refund_total_tax,
        coalesce(daily_orders.total_discounts, 0) as total_discounts,
        daily_orders.avg_discount,
        coalesce(daily_orders.shipping_discount_amount, 0) as shipping_discount_amount,
        daily_orders.avg_shipping_discount_amount,
        coalesce(daily_orders.percentage_calc_discount_amount, 0) as percentage_calc_discount_amount,
        daily_orders.avg_percentage_calc_discount_amount,
        coalesce(daily_orders.fixed_amount_discount_amount, 0) as fixed_amount_discount_amount,
        daily_orders.avg_fixed_amount_discount_amount,
        coalesce(daily_orders.count_discount_codes_applied, 0) as count_discount_codes_applied,
        coalesce(daily_orders.count_locations_ordered_from, 0) as count_locations_ordered_from,
        coalesce(daily_orders.count_orders_with_discounts, 0) as count_orders_with_discounts,
        coalesce(daily_orders.count_orders_with_refunds, 0) as count_orders_with_refunds,
        daily_orders.first_order_timestamp,
        daily_orders.last_order_timestamp,

        coalesce(daily_orders.quantity_sold, 0) as quantity_sold,
        coalesce(daily_orders.quantity_refunded, 0) as quantity_refunded,
        coalesce(daily_orders.quantity_net, 0) as quantity_net,
        daily_orders.avg_quantity_sold,
        daily_orders.avg_quantity_net,
        coalesce(daily_orders.count_variants_sold, 0) as count_variants_sold,
        coalesce(daily_orders.count_products_sold, 0) as count_products_sold,
        coalesce(daily_orders.quantity_gift_cards_sold, 0) as quantity_gift_cards_sold,
        coalesce(daily_orders.quantity_requiring_shipping, 0) as quantity_requiring_shipping,

        coalesce(daily_abandoned_checkouts.count_abandoned_checkouts, 0) as count_abandoned_checkouts,
        coalesce(daily_abandoned_checkouts.count_customers_abandoned_checkout, 0) as count_customers_abandoned_checkout,
        coalesce(daily_abandoned_checkouts.count_customer_emails_abandoned_checkout, 0) as count_customer_emails_abandoned_checkout

        {% if var('shopify_using_fulfillment_event', false) %}
            {% for status in ['attempted_delivery', 'delayed', 'delivered', 'failure', 'in_transit', 'out_for_delivery', 'ready_for_pickup', 'picked_up', 'label_printed', 'label_purchased', 'confirmed']%}
        , coalesce(count_fulfillment_{{ status }}, 0) as count_fulfillment_{{ status }}
            {% endfor %}
        {% endif %}

    from shop_calendar
    left join daily_orders 
        on shop_calendar.source_relation = daily_orders.source_relation
        and shop_calendar.date_day = daily_orders.date_day
    left join daily_abandoned_checkouts 
        on shop_calendar.source_relation = daily_abandoned_checkouts.source_relation
        and shop_calendar.date_day = daily_abandoned_checkouts.date_day
    {% if var('shopify_using_fulfillment_event', false) %}
    left join daily_fulfillment 
        on shop_calendar.source_relation = daily_fulfillment.source_relation
        and shop_calendar.date_day = daily_fulfillment.date_day
    {% endif %}
    
)


select *
from final
