{{ config(
    tags="fivetran_validations",
    enabled=var('fivetran_validation_tests_enabled', false)
) }}
-- test will only run if shopify_using_fulfillment_event is set to True

with source as (

    select *
    from {{ ref('stg_shopify__fulfillment_event') }}
),

source_metrics as (

    select 
        source_relation,
        cast({{ dbt.date_trunc('day','happened_at') }} as date) as date_day,
        shop_id,
        count(distinct case when status = 'delayed' then fulfillment_id end) as count_fulfillment_delayed,
        count(distinct case when status = 'in_transit' then fulfillment_id end) as count_fulfillment_in_transit,
        count(distinct case when status = 'confirmed' then fulfillment_id end) as count_fulfillment_confirmed,
        count(distinct case when status = 'delivered' then fulfillment_id end) as count_fulfillment_delivered

    from source
    where happened_at > '2020-01-01' and happened_at < '2024-06-10'
    group by 1,2,3
),

model as (

    select *
    from {{ ref('shopify__daily_shop') }}
),

model_metrics as (

    select 
        source_relation,
        date_day,
        shop_id,
        sum(count_fulfillment_delayed) as count_fulfillment_delayed,
        sum(count_fulfillment_in_transit) as count_fulfillment_in_transit,
        sum(count_fulfillment_confirmed) as count_fulfillment_confirmed,
        sum(count_fulfillment_delivered) as count_fulfillment_delivered

    from model
    where date_day >= '2020-01-01' and date_day < '2024-06-10'
    group by 1,2,3
),

final as (

    select
        model_metrics.source_relation,
        model_metrics.shop_id as model_shop_id,
        source_metrics.shop_id as source_shop_id,
        model_metrics.date_day as model_date_day,
        source_metrics.date_day as source_date_day,
        coalesce(model_metrics.count_fulfillment_delayed, 0) as model_count_fulfillment_delayed,
        coalesce(source_metrics.count_fulfillment_delayed, 0) as source_count_fulfillment_delayed,
        coalesce(model_metrics.count_fulfillment_in_transit, 0) as model_count_fulfillment_in_transit,
        coalesce(source_metrics.count_fulfillment_in_transit, 0) as source_count_fulfillment_in_transit,
        coalesce(model_metrics.count_fulfillment_confirmed, 0) as model_count_fulfillment_confirmed,
        coalesce(source_metrics.count_fulfillment_confirmed, 0) as source_count_fulfillment_confirmed,
        coalesce(model_metrics.count_fulfillment_delivered, 0) as model_count_fulfillment_delivered,
        coalesce(source_metrics.count_fulfillment_delivered, 0) as source_count_fulfillment_delivered

    from model_metrics
    full outer join source_metrics
        on model_metrics.source_relation = source_metrics.source_relation
        and model_metrics.shop_id = source_metrics.shop_id
        and model_metrics.date_day = source_metrics.date_day
)

select *
from final
where 
model_count_fulfillment_delayed != source_count_fulfillment_delayed or
model_count_fulfillment_in_transit != source_count_fulfillment_in_transit or
model_count_fulfillment_confirmed != source_count_fulfillment_confirmed or
model_count_fulfillment_delivered != source_count_fulfillment_delivered