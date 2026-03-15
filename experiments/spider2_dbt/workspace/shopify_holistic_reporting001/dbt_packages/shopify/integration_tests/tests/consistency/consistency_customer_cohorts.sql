{{ config(
    tags="fivetran_validations",
    enabled=var('fivetran_validation_tests_enabled', false)
) }}

with prod as (

    select
        customer_cohort_id, 
        source_relation,
        total_price_lifetime,
        order_count_lifetime,
        line_item_count_lifetime
    from {{ target.schema }}_shopify_prod.shopify__customer_cohorts
),

dev as (

    select
        customer_cohort_id, 
        source_relation,
        total_price_lifetime,
        order_count_lifetime,
        line_item_count_lifetime
    from {{ target.schema }}_shopify_dev.shopify__customer_cohorts 
),

final as (

    select 
        prod.customer_cohort_id as prod_customer_cohort_id,
        dev.customer_cohort_id as dev_customer_cohort_id,
        prod.source_relation as prod_source_relation,
        dev.source_relation as dev_source_relation,
        prod.total_price_lifetime as prod_total_price_lifetime,
        dev.total_price_lifetime as dev_total_price_lifetime,
        prod.order_count_lifetime as prod_order_count_lifetime,
        dev.order_count_lifetime as dev_order_count_lifetime,
        prod.line_item_count_lifetime as prod_line_item_count_lifetime,
        dev.line_item_count_lifetime as dev_line_item_count_lifetime
    from prod
    full outer join dev 
        on dev.customer_cohort_id = prod.customer_cohort_id
        and dev.source_relation = prod.source_relation
)

select *
from final
where 
    prod_customer_cohort_id != dev_customer_cohort_id or 
    prod_source_relation != dev_source_relation or
    abs(prod_total_price_lifetime - dev_total_price_lifetime) > .001 or
    abs(prod_order_count_lifetime - dev_order_count_lifetime) > .001 or
    abs(prod_line_item_count_lifetime - dev_line_item_count_lifetime) > .001