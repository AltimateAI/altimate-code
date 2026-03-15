with customers as (

    select 
        {{ dbt_utils.star(from=ref('stg_shopify__customer'), except=["orders_count", "total_spent"]) }}
    from {{ var('shopify_customer') }}

), orders as (

    select *
    from {{ ref('shopify__customers__order_aggregates' )}}

), abandoned as (

    select 
        customer_id,
        source_relation,
        count(distinct checkout_id) as lifetime_abandoned_checkouts
    from {{ var('shopify_abandoned_checkout' )}}
    where customer_id is not null
    group by 1,2

), customer_tags_aggregated as (

    select 
        customer_id,
        source_relation,
        {{ fivetran_utils.string_agg("distinct cast(value as " ~ dbt.type_string() ~ ")", "', '") }} as customer_tags

    from {{ var('shopify_customer_tag' )}}
    group by 1,2

), joined as (

    select 
        customers.*,
        coalesce(abandoned.lifetime_abandoned_checkouts, 0) as lifetime_abandoned_checkouts,
        orders.first_order_timestamp,
        orders.most_recent_order_timestamp,
        customer_tags_aggregated.customer_tags,
        orders.avg_order_value,
        coalesce(orders.lifetime_total_spent, 0) as lifetime_total_spent,
        coalesce(orders.lifetime_total_refunded, 0) as lifetime_total_refunded,
        (coalesce(orders.lifetime_total_spent, 0) - coalesce(orders.lifetime_total_refunded, 0)) as lifetime_total_net,
        coalesce(orders.lifetime_count_orders, 0) as lifetime_count_orders,
        orders.avg_quantity_per_order,
        coalesce(orders.lifetime_total_tax, 0) as lifetime_total_tax,
        orders.avg_tax_per_order,
        coalesce(orders.lifetime_total_discount, 0) as lifetime_total_discount,
        orders.avg_discount_per_order,
        coalesce(orders.lifetime_total_shipping, 0) as lifetime_total_shipping,
        orders.avg_shipping_per_order,
        coalesce(orders.lifetime_total_shipping_with_discounts, 0) as lifetime_total_shipping_with_discounts,
        orders.avg_shipping_with_discounts_per_order,
        coalesce(orders.lifetime_total_shipping_tax, 0) as lifetime_total_shipping_tax,
        orders.avg_shipping_tax_per_order

    from customers
    left join orders
        on customers.customer_id = orders.customer_id
        and customers.source_relation = orders.source_relation
    left join abandoned
        on customers.customer_id = abandoned.customer_id
        and customers.source_relation = abandoned.source_relation
    left join customer_tags_aggregated
        on customers.customer_id = customer_tags_aggregated.customer_id
        and customers.source_relation = customer_tags_aggregated.source_relation
)

select *
from joined