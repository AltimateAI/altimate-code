{{ config(materialized='table') }}

with events as (

    select * from {{ ref('stg_events') }}

),

daily as (

    select
        event_id,
        event_type,
        customer_id,
        cast(loaded_at as date) as event_date,
        count(*) as event_count,
        sum(amount_usd) as total_amount_usd
    from events
    group by event_id, event_type, customer_id, cast(loaded_at as date)

)

select *
from daily
order by event_date, customer_id
