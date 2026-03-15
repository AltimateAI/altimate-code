{{ config(
    tags="fivetran_validations",
    enabled=var('fivetran_validation_tests_enabled', false)
) }}

with calendar as (

    select *
    from {{ ref('shopify__calendar') }}
    where cast({{ dbt.date_trunc('month','date_day') }} as date) = date_day

), 

customers as (

    select *
    from {{ ref('shopify__customers') }}

), 

orders as (

    select *
    from {{ ref('shopify__orders') }}

), 

customer_cohort_source as (

    select 
        customers.source_relation,
        count(*) as source_rows 
    from calendar
    inner join customers
        on cast({{ dbt.date_trunc('month', 'first_order_timestamp') }} as date) <= calendar.date_day
    group by 1
),

customer_cohort_end as (

    select 
        source_relation,
        count(*) as end_rows
    from {{ ref('shopify__customer_cohorts') }}
    group by 1
),

final as (
    select
        customer_cohort_source.source_relation,
        source_rows,
        end_rows
    from customer_cohort_source
    join customer_cohort_end
    on customer_cohort_source.source_relation = customer_cohort_end.source_relation
    where customer_cohort_source.source_rows != customer_cohort_end.end_rows
)

select *
from final

