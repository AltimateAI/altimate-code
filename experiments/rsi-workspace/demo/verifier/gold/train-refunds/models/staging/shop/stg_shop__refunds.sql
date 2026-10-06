with source as (

    select * from {{ source('shop', 'refunds') }}
    where not _is_deleted

),

renamed as (

    select
        id as refund_id,
        order_id,
        {{ cents_to_dollars('amount_cents') }} as amount,
        reason,
        {{ to_utc('refunded_ts') }} as refunded_at
    from source

)

select * from renamed
