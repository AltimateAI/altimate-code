with source as (

    select * from {{ source('billing', 'invoices') }}
    where not _is_deleted

),

renamed as (

    select
        id as invoice_id,
        customer_id,
        subscription_id,
        {{ cents_to_dollars('total_cents') }} as total,
        {{ cents_to_dollars('tax_cents') }} as tax,
        {{ to_utc('issued_ts') }} as issued_at,
        {{ to_utc('due_ts') }} as due_at
    from source

)

select * from renamed
