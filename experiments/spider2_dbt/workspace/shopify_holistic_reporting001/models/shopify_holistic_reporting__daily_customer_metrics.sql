with shopify as (

    select *
    from {{ ref('int__daily_shopify_customer_orders') }}

), klaviyo as (

    select *
    from {{ ref('int__daily_klaviyo_user_metrics') }}

), joined as (

    -- full outer join to capture records that exist in only one source
    select
        coalesce(shopify.date_day, klaviyo.date_day) as date_day,
        coalesce(lower(shopify.email), lower(klaviyo.email)) as email,

        -- attribution IDs: coalesce from shopify last_touch then klaviyo
        coalesce(shopify.last_touch_campaign_id, klaviyo.last_touch_campaign_id) as campaign_id,
        coalesce(shopify.last_touch_flow_id, klaviyo.last_touch_flow_id) as flow_id,

        -- campaign/flow metadata from Klaviyo (source of truth), fallback to Shopify last_touch
        coalesce(klaviyo.campaign_name, shopify.last_touch_campaign_name) as campaign_name,
        coalesce(klaviyo.flow_name, shopify.last_touch_flow_name) as flow_name,
        coalesce(klaviyo.variation_id, shopify.last_touch_variation_id) as variation_id,

        -- Klaviyo event timestamps
        klaviyo.first_event_at as klaviyo_first_event_at,
        klaviyo.last_event_at as klaviyo_last_event_at,

        -- campaign metadata
        coalesce(klaviyo.campaign_subject_line, shopify.last_touch_campaign_subject_line) as campaign_subject_line,
        coalesce(klaviyo.campaign_type, shopify.last_touch_campaign_type) as campaign_type,

        -- source relations (prefixed to distinguish the two platforms)
        shopify.source_relation as shopify_source_relation,
        klaviyo.source_relation as klaviyo_source_relation,

        -- Shopify order metrics (prefixed)
        shopify.total_orders as shopify_total_orders,
        shopify.total_price as shopify_total_price,
        shopify.count_line_items as shopify_count_line_items,
        shopify.total_line_items_price as shopify_total_line_items_price,
        shopify.total_discounts as shopify_total_discounts,
        shopify.total_tax as shopify_total_tax,
        shopify.total_shipping_cost as shopify_total_shipping_cost,
        shopify.total_refund_subtotal as shopify_total_refund_subtotal,
        shopify.total_refund_tax as shopify_total_refund_tax,
        shopify.count_cancelled_orders as shopify_count_cancelled_orders,
        shopify.count_products as shopify_count_products,
        shopify.count_product_variants as shopify_count_product_variants,
        shopify.sum_quantity as shopify_sum_quantity,
        shopify.total_order_adjustment_amount as shopify_total_order_adjustment_amount,
        shopify.total_order_adjustment_tax_amount as shopify_total_order_adjustment_tax_amount,

        -- Klaviyo sum_revenue metrics
        klaviyo.sum_revenue_refunded_order,
        klaviyo.sum_revenue_placed_order,
        klaviyo.sum_revenue_ordered_product,
        klaviyo.sum_revenue_checkout_started,
        klaviyo.sum_revenue_cancelled_order,

        -- Klaviyo count metrics
        klaviyo.count_active_on_site,
        klaviyo.count_viewed_product,
        klaviyo.count_ordered_product,
        klaviyo.count_placed_order,
        klaviyo.count_refunded_order,
        klaviyo.count_received_email,
        klaviyo.count_clicked_email,
        klaviyo.count_opened_email,
        klaviyo.count_marked_email_as_spam,
        klaviyo.count_unsubscribed,
        klaviyo.count_received_sms,
        klaviyo.count_clicked_sms,
        klaviyo.count_sent_sms,
        klaviyo.count_unsubscribed_from_sms

    from shopify
    full outer join klaviyo
        on lower(shopify.email) = lower(klaviyo.email)
        and shopify.date_day = klaviyo.date_day
        and coalesce(shopify.last_touch_campaign_id, '') = coalesce(klaviyo.last_touch_campaign_id, '')
        and coalesce(shopify.last_touch_flow_id, '') = coalesce(klaviyo.last_touch_flow_id, '')
        and coalesce(shopify.last_touch_variation_id, '') = coalesce(klaviyo.variation_id, '')

)

select *
from joined
