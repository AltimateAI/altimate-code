with source as (

    select * from {{ source('shop', 'customers') }}

),

order_counts as (

    select customer_id, count(*) as order_count
    from {{ source('shop', 'orders') }}
    group by customer_id

),

renamed as (

    select
        source.id as customer_id,
        source.first_name,
        source.last_name,
        source.email,
        source.country,
        coalesce(order_counts.order_count, 0) >= 3 as is_vip
    from source
    left join order_counts on order_counts.customer_id = source.id

)

select * from renamed
