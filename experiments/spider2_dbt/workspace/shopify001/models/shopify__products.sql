with products_with_agg as (

    select *
    from {{ ref('int_shopify__products_with_aggregates') }}

), product_order_lines as (

    select *
    from {{ ref('int_shopify__product__order_line_aggregates') }}

), joined as (

    select
        products_with_agg.is_deleted,
        products_with_agg._fivetran_synced,
        products_with_agg.created_timestamp,
        products_with_agg.handle,
        products_with_agg.product_id,
        products_with_agg.product_type,
        products_with_agg.published_timestamp,
        products_with_agg.published_scope,
        products_with_agg.title,
        products_with_agg.updated_timestamp,
        products_with_agg.vendor,
        coalesce(product_order_lines.quantity_sold, 0) as total_quantity_sold,
        coalesce(product_order_lines.subtotal_sold, 0) as subtotal_sold,
        coalesce(product_order_lines.quantity_sold_net_refunds, 0) as quantity_sold_net_refunds,
        coalesce(product_order_lines.subtotal_sold_net_refunds, 0) as subtotal_sold_net_refunds,
        product_order_lines.first_order_timestamp,
        product_order_lines.most_recent_order_timestamp,
        products_with_agg.source_relation,
        coalesce(product_order_lines.avg_quantity_per_order_line, 0) as avg_quantity_per_order_line,
        coalesce(product_order_lines.product_total_discount, 0) as product_total_discount,
        coalesce(product_order_lines.product_avg_discount_per_order_line, 0) as product_avg_discount_per_order_line,
        coalesce(product_order_lines.product_total_tax, 0) as product_total_tax,
        coalesce(product_order_lines.product_avg_tax_per_order_line, 0) as product_avg_tax_per_order_line,
        products_with_agg.count_variants,
        products_with_agg.has_product_image,
        products_with_agg.status,
        products_with_agg.collections,
        products_with_agg.tags

    from products_with_agg
    left join product_order_lines
        on products_with_agg.product_id = product_order_lines.product_id
        and products_with_agg.source_relation = product_order_lines.source_relation

)

select *
from joined
