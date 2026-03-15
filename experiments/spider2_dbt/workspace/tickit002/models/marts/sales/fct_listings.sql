{{ config(materialized='table', sort='list_id', dist='list_id') }}

with categories as (

    select * from {{ ref('stg_tickit__categories') }}

),

events as (

    select * from {{ ref('stg_tickit__events') }}

),

listings as (

    select * from {{ ref('stg_tickit__listings') }}

),

venues as (

    select * from {{ ref('stg_tickit__venues') }}

),

sellers as (

    select * from {{ ref('int_sellers_extracted_from_users') }}

),

final as (

    select
        l.list_id,
        l.list_time,
        c.cat_group,
        c.cat_name,
        e.event_name,
        v.venue_name,
        v.venue_city,
        v.venue_state,
        e.start_time,
        se.username as seller_username,
        se.full_name as seller_name,
        l.num_tickets,
        l.price_per_ticket,
        l.total_price
    from
        listings as l
            join events as e on e.event_id = l.event_id
            join venues as v on v.venue_id = e.venue_id
            join categories as c on c.cat_id = e.cat_id
            join sellers as se on se.user_id = l.seller_id
    order by
        list_id

)

select * from final
