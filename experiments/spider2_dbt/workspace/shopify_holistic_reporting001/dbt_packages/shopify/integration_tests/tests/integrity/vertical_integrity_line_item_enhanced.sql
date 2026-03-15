{{ config(
    tags="fivetran_validations",
    enabled=var('fivetran_validation_tests_enabled', false)
) }}

-- this test is to make sure there is no fanout between the staging order_line_table and the line_item_enhanced model.
with stg_order_line as (
    select
        1 as join_key,
        count(*) as order_line_count,
        count(distinct order_id) as order_count
    from {{ ref('stg_shopify__order_line') }}
),

line_item_enhanced as (
    select
        1 as join_key,
        count(*) as line_item_enhanced_count
    from {{ ref('shopify__line_item_enhanced') }}
),

-- test will return values and fail if the row counts don't match

final as (
    select 
        stg_order_line.join_key,
        stg_order_line.order_line_count + stg_order_line.order_count as total_line_and_order_count,
        line_item_enhanced.line_item_enhanced_count
    from stg_order_line
    join line_item_enhanced
        on stg_order_line.join_key = line_item_enhanced.join_key
) 

select *
from final
where total_line_and_order_count != line_item_enhanced_count