{{
    config(
        materialized='table' if shopify.shopify_is_databricks_sql_warehouse() else 'incremental',
        unique_key='customer_cohort_id',
        incremental_strategy='insert_overwrite' if target.type in ('bigquery', 'databricks', 'spark') else 'delete+insert',
        partition_by={
            "field": "date_month", 
            "data_type": "date"
            } if target.type not in ('spark','databricks') 
            else ['date_month'],
        cluster_by=['date_month', 'email'],
        file_format='delta' if shopify.shopify_is_databricks_sql_warehouse() else 'parquet'
        ) 
}}

with calendar as (

    select *
    from {{ ref('shopify__calendar') }}
    where cast({{ dbt.date_trunc('month','date_day') }} as date) = date_day

    {% if is_incremental() %}
    and cast(date_day as date) >= {{ shopify.shopify_lookback(from_date="max(date_month)", interval=1, datepart='month') }}
    {% endif %}

), customers as (

    select *
    from {{ ref('shopify__customer_emails') }}

), orders as (

    select *
    from {{ ref('shopify__orders') }}

), customer_calendar as (

    select
        cast(calendar.date_day as date) as date_month,
        customers.email,
        customers.first_order_timestamp,
        customers.source_relation,
        {{ dbt.date_trunc('month', 'first_order_timestamp') }} as cohort_month
    from calendar
    inner join customers
        on cast({{ dbt.date_trunc('month', 'first_order_timestamp') }} as date) <= calendar.date_day

), orders_joined as (

    select 
        customer_calendar.date_month, 
        customer_calendar.email, 
        customer_calendar.first_order_timestamp,
        customer_calendar.cohort_month,
        customer_calendar.source_relation,
        coalesce(count(distinct orders.order_id), 0) as order_count_in_month,
        coalesce(sum(orders.order_adjusted_total), 0) as total_price_in_month,
        coalesce(sum(orders.line_item_count), 0) as line_item_count_in_month
    from customer_calendar
    left join orders
        on customer_calendar.email = orders.email
        and customer_calendar.source_relation = orders.source_relation
        and customer_calendar.date_month = cast({{ dbt.date_trunc('month', 'created_timestamp') }} as date)
    {{ dbt_utils.group_by(n=5) }}

), windows as (

    {% set partition_string = 'partition by ' ~ shopify.shopify_partition_by_cols('email', 'source_relation') ~ 'order by date_month rows between unbounded preceding and current row' %}

    select
        *,
        sum(total_price_in_month) over ({{ partition_string }}) as total_price_lifetime,
        sum(order_count_in_month) over ({{ partition_string }}) as order_count_lifetime,
        sum(line_item_count_in_month) over ({{ partition_string }}) as line_item_count_lifetime,
        row_number() over ( 
            partition by {{ shopify.shopify_partition_by_cols('email', 'source_relation') }}
            order by date_month asc) 
            as cohort_month_number
    from orders_joined

{% if is_incremental() %}
), backfill_lifetime_sums as (
    -- for incremental runs we need to fetch the prior lifetimes to properly continue adding to them
    select
        source_relation,
        email,
        max(total_price_lifetime) as previous_total_price_lifetime,
        max(order_count_lifetime) as previous_order_count_lifetime,
        max(line_item_count_lifetime) as previous_line_item_count_lifetime,
        max(cohort_month_number) as previous_cohort_month_number
    from {{ this }}
    where date_month < {{ shopify.shopify_lookback(from_date="max(date_month)", interval=1, datepart='month') }}
    group by 1,2

), final as (

    select 
        windows.date_month, 
        windows.email, 
        windows.first_order_timestamp,
        windows.cohort_month,
        windows.source_relation,
        windows.order_count_in_month,
        windows.total_price_in_month,
        windows.line_item_count_in_month,
        backfill_lifetime_sums.previous_cohort_month_number + windows.cohort_month_number as cohort_month_number,
        backfill_lifetime_sums.previous_total_price_lifetime + windows.total_price_lifetime as total_price_lifetime,
        backfill_lifetime_sums.previous_order_count_lifetime + windows.order_count_lifetime as order_count_lifetime,
        backfill_lifetime_sums.previous_line_item_count_lifetime + windows.line_item_count_lifetime as line_item_count_lifetime,
        {{ dbt_utils.generate_surrogate_key(['windows.date_month','windows.email','windows.source_relation']) }} as customer_cohort_id
    from windows
    left join backfill_lifetime_sums
        on backfill_lifetime_sums.source_relation = windows.source_relation
        and backfill_lifetime_sums.email = windows.email

{% else %}
), final as (

    select 
        *, 
        {{ dbt_utils.generate_surrogate_key(['date_month','email','source_relation']) }} as customer_cohort_id
    from windows

{% endif %}
)

select *
from final