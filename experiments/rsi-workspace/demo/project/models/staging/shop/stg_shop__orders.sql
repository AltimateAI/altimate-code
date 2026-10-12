with source as (

    select * from {{ source('shop', 'orders') }}

),

renamed as (

    select
        id as order_id,
        customer_id,
        status,
        order_date,
        {{ cents_to_dollars('amount_cents') }} as amount
    from source

)

select * from renamed
