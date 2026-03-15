with calendar as (

    select *
    from {{ ref('shopify__calendar') }}
),

shop as (

    select *
    from {{ var('shopify_shop') }}
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

-- cross join shop with calendar to get one row per shop per day
shop_calendar as (

    select
        cast(calendar.date_day as date) as date_day,
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
    cross join shop
),

joined as (

    select
        shop_calendar.date_day,
        shop_calendar.shop_id,
        shop_calendar.name,
        shop_calendar.domain,
        shop_calendar.is_deleted,
        shop_calendar.currency,
        shop_calendar.enabled_presentment_currencies,
        shop_calendar.iana_timezone,
        shop_calendar.created_at,
        coalesce(daily_orders.count_orders, 0) as count_orders,
        coalesce(daily_orders.count_line_items, 0) as count_line_items,
        coalesce(daily_orders.count_customers, 0) as count_customers,
        coalesce(daily_orders.count_customer_emails, 0) as count_customer_emails,
        coalesce(daily_orders.order_adjusted_total, 0) as order_adjusted_total,
        coalesce(daily_orders.avg_order_value, 0) as avg_order_value,
        coalesce(daily_orders.shipping_cost, 0) as shipping_cost,
        coalesce(daily_orders.order_adjustment_amount, 0) as order_adjustment_amount,
        coalesce(daily_orders.order_adjustment_tax_amount, 0) as order_adjustment_tax_amount,
        coalesce(daily_orders.refund_subtotal, 0) as refund_subtotal,
        coalesce(daily_orders.refund_total_tax, 0) as refund_total_tax,
        coalesce(daily_orders.total_discounts, 0) as total_discounts,
        coalesce(daily_orders.shipping_discount_amount, 0) as shipping_discount_amount,
        coalesce(daily_orders.percentage_calc_discount_amount, 0) as percentage_calc_discount_amount,
        coalesce(daily_orders.fixed_amount_discount_amount, 0) as fixed_amount_discount_amount,
        coalesce(daily_orders.count_discount_codes_applied, 0) as count_discount_codes_applied,
        coalesce(daily_orders.count_locations_ordered_from, 0) as count_locations_ordered_from,
        coalesce(daily_orders.count_orders_with_discounts, 0) as count_orders_with_discounts,
        coalesce(daily_orders.count_orders_with_refunds, 0) as count_orders_with_refunds,
        daily_orders.first_order_timestamp,
        daily_orders.last_order_timestamp,
        coalesce(daily_orders.quantity_sold, 0) as quantity_sold,
        coalesce(daily_orders.quantity_refunded, 0) as quantity_refunded,
        coalesce(daily_orders.quantity_net, 0) as quantity_net,
        coalesce(daily_orders.count_variants_sold, 0) as count_variants_sold,
        coalesce(daily_orders.count_products_sold, 0) as count_products_sold,
        coalesce(daily_orders.quantity_gift_cards_sold, 0) as quantity_gift_cards_sold,
        coalesce(daily_orders.quantity_requiring_shipping, 0) as quantity_requiring_shipping,
        coalesce(daily_abandoned_checkouts.count_abandoned_checkouts, 0) as count_abandoned_checkouts,
        coalesce(daily_abandoned_checkouts.count_customers_abandoned_checkout, 0) as count_customers_abandoned_checkout,
        coalesce(daily_abandoned_checkouts.count_customer_emails_abandoned_checkout, 0) as count_customer_emails_abandoned_checkout

        {% if var('shopify_using_fulfillment_event', false) %}
        , coalesce(daily_fulfillment.count_fulfillment_attempted_delivery, 0) as count_fulfillment_attempted_delivery
        , coalesce(daily_fulfillment.count_fulfillment_delivered, 0) as count_fulfillment_delivered
        , coalesce(daily_fulfillment.count_fulfillment_failure, 0) as count_fulfillment_failure
        , coalesce(daily_fulfillment.count_fulfillment_in_transit, 0) as count_fulfillment_in_transit
        , coalesce(daily_fulfillment.count_fulfillment_out_for_delivery, 0) as count_fulfillment_out_for_delivery
        , coalesce(daily_fulfillment.count_fulfillment_ready_for_pickup, 0) as count_fulfillment_ready_for_pickup
        , coalesce(daily_fulfillment.count_fulfillment_picked_up, 0) as count_fulfillment_picked_up
        , coalesce(daily_fulfillment.count_fulfillment_label_printed, 0) as count_fulfillment_label_printed
        , coalesce(daily_fulfillment.count_fulfillment_label_purchased, 0) as count_fulfillment_label_purchased
        , coalesce(daily_fulfillment.count_fulfillment_confirmed, 0) as count_fulfillment_confirmed
        , coalesce(daily_fulfillment.count_fulfillment_delayed, 0) as count_fulfillment_delayed
        {% else %}
        , 0 as count_fulfillment_attempted_delivery
        , 0 as count_fulfillment_delivered
        , 0 as count_fulfillment_failure
        , 0 as count_fulfillment_in_transit
        , 0 as count_fulfillment_out_for_delivery
        , 0 as count_fulfillment_ready_for_pickup
        , 0 as count_fulfillment_picked_up
        , 0 as count_fulfillment_label_printed
        , 0 as count_fulfillment_label_purchased
        , 0 as count_fulfillment_confirmed
        , 0 as count_fulfillment_delayed
        {% endif %}

        , coalesce(daily_orders.avg_line_item_count, 0) as avg_line_item_count
        , coalesce(daily_orders.avg_discount, 0) as avg_discount
        , coalesce(daily_orders.avg_shipping_discount_amount, 0) as avg_shipping_discount_amount
        , coalesce(daily_orders.avg_percentage_calc_discount_amount, 0) as avg_percentage_calc_discount_amount
        , coalesce(daily_orders.avg_fixed_amount_discount_amount, 0) as avg_fixed_amount_discount_amount
        , coalesce(daily_orders.avg_quantity_sold, 0) as avg_quantity_sold
        , coalesce(daily_orders.avg_quantity_net, 0) as avg_quantity_net
        , shop_calendar.source_relation

    from shop_calendar
    left join daily_orders
        on shop_calendar.date_day = daily_orders.date_day
        and shop_calendar.source_relation = daily_orders.source_relation
    left join daily_abandoned_checkouts
        on shop_calendar.date_day = daily_abandoned_checkouts.date_day
        and shop_calendar.source_relation = daily_abandoned_checkouts.source_relation

    {% if var('shopify_using_fulfillment_event', false) %}
    left join daily_fulfillment
        on shop_calendar.date_day = daily_fulfillment.date_day
        and shop_calendar.source_relation = daily_fulfillment.source_relation
    {% endif %}
)

select *
from joined
