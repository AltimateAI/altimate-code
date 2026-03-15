with products as (

    select *
    from {{ ref('int_shopify__products_with_aggregates') }}

), product_order_lines as (

    select *
    from {{ ref('int_shopify__product__order_line_aggregates')}}

), joined as (

    select
        products.*,
        coalesce(product_order_lines.quantity_sold,0) as total_quantity_sold,
        coalesce(product_order_lines.subtotal_sold,0) as subtotal_sold,
        coalesce(product_order_lines.quantity_sold_net_refunds,0) as quantity_sold_net_refunds,
        coalesce(product_order_lines.subtotal_sold_net_refunds,0) as subtotal_sold_net_refunds,
        product_order_lines.first_order_timestamp,
        product_order_lines.most_recent_order_timestamp,
        product_order_lines.avg_quantity_per_order_line as avg_quantity_per_order_line,
        coalesce(product_order_lines.product_total_discount,0) as product_total_discount,
        product_order_lines.product_avg_discount_per_order_line as product_avg_discount_per_order_line,
        coalesce(product_order_lines.product_total_tax,0) as product_total_tax,
        product_order_lines.product_avg_tax_per_order_line as product_avg_tax_per_order_line

    from products
    left join product_order_lines
        on products.product_id = product_order_lines.product_id
        and products.source_relation = product_order_lines.source_relation
)

select *
from joined