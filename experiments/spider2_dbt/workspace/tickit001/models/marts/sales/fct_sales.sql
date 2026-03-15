{{ config(materialized='table', sort='sale_id', dist='sale_id') }}

with sales as (

    select * from {{ ref('stg_tickit__sales') }}

),

buyers as (

    select * from {{ ref('int_buyers_extracted_from_users') }}

),

sellers as (

    select * from {{ ref('int_sellers_extracted_from_users') }}

),

events as (

    select * from {{ ref('stg_tickit__events') }}

),

categories as (

    select * from {{ ref('stg_tickit__categories') }}

),

dates as (

    select * from {{ ref('stg_tickit__dates') }}

),

final as (

    select
        s.sale_id,
        s.sale_time,
        d.qtr,
        c.cat_group,
        c.cat_name,
        e.event_name,
        b.username as buyer_username,
        b.full_name as buyer_name,
        b.state as buyer_state,
        b.first_purchase_date as buyer_first_purchase_date,
        se.username as seller_username,
        se.full_name as seller_name,
        se.state as seller_state,
        se.first_sale_date as seller_first_sale_date,
        s.ticket_price,
        s.qty_sold,
        s.price_paid,
        s.commission_prcnt,
        s.commission,
        s.earnings
    from
        sales as s
            join buyers as b on b.user_id = s.buyer_id
            join sellers as se on se.user_id = s.seller_id
            join events as e on e.event_id = s.event_id
            join categories as c on c.cat_id = e.cat_id
            join dates as d on d.date_id = s.date_id
    order by
        s.sale_id

)

select * from final
