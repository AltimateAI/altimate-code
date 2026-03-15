{{ config(
    tags="fivetran_validations",
    enabled=var('fivetran_validation_tests_enabled', false)
) }}

with prod as (
    select
        date_day,
        shop_id, 
        source_relation,
        sum(count_orders) as count_orders,
        count(count_customers) as count_customers,
        sum(order_adjusted_total) as order_adjusted_total,
        sum(count_abandoned_checkouts) as count_abandoned_checkouts

        {% if var('shopify_using_fulfillment_event', false) %}
        , sum(count_fulfillment_attempted_delivery) as count_fulfillment_attempted_delivery
        , sum(count_fulfillment_confirmed) as count_fulfillment_confirmed
        , count(count_fulfillment_in_transit) as count_fulfillment_in_transit
        {% endif %}

    from {{ target.schema }}_shopify_prod.shopify__daily_shop
    group by 1,2,3
),

dev as (
    select
        date_day,
        shop_id, 
        source_relation,
        sum(count_orders) as count_orders,
        count(count_customers) as count_customers,
        sum(order_adjusted_total) as order_adjusted_total,
        sum(count_abandoned_checkouts) as count_abandoned_checkouts

        {% if var('shopify_using_fulfillment_event', false) %}
        , sum(count_fulfillment_attempted_delivery) as count_fulfillment_attempted_delivery
        , sum(count_fulfillment_confirmed) as count_fulfillment_confirmed
        , count(count_fulfillment_in_transit) as count_fulfillment_in_transit
        {% endif %}

    from {{ target.schema }}_shopify_dev.shopify__daily_shop
    group by 1,2,3
),

final as (
    select 
        prod.date_day as prod_date_day,
        dev.date_day as dev_date_day,
        prod.shop_id as prod_shop_id,
        dev.shop_id as dev_shop_id,
        prod.source_relation as prod_source_relation,
        dev.source_relation as dev_source_relation,
        prod.count_orders as prod_count_orders,
        dev.count_orders as dev_count_orders,
        prod.count_customers as prod_count_customers,
        dev.count_customers as dev_count_customers,
        prod.order_adjusted_total as prod_order_adjusted_total,
        dev.order_adjusted_total as dev_order_adjusted_total,
        prod.count_abandoned_checkouts as prod_count_abandoned_checkouts,
        dev.count_abandoned_checkouts as dev_count_abandoned_checkouts

        {% if var('shopify_using_fulfillment_event', false) %}
        , prod.count_fulfillment_attempted_delivery as prod_count_fulfillment_attempted_delivery
        , dev.count_fulfillment_attempted_delivery as dev_count_fulfillment_attempted_delivery
        , prod.count_fulfillment_confirmed as prod_count_fulfillment_confirmed
        , dev.count_fulfillment_confirmed as dev_count_fulfillment_confirmed
        {% endif %}

    from prod
    full outer join dev 
        on dev.date_day = prod.date_day
        and dev.shop_id = prod.shop_id
        and dev.source_relation = prod.source_relation
)

select *
from final
where 
    prod_date_day != dev_date_day or
    prod_shop_id != dev_shop_id or
    prod_source_relation != dev_source_relation or
    abs(prod_count_orders - dev_count_orders) > .001 or
    abs(prod_count_customers - dev_count_customers) > .001 or
    abs(prod_order_adjusted_total - dev_order_adjusted_total) > .001 or
    abs(prod_count_abandoned_checkouts - dev_count_abandoned_checkouts) > .001
    
    {% if var('shopify_using_fulfillment_event', false) %}
    or abs(prod_count_fulfillment_attempted_delivery - dev_count_fulfillment_attempted_delivery) > .001
    or abs(prod_count_fulfillment_confirmed - dev_count_fulfillment_confirmed) > .001
    {% endif %}