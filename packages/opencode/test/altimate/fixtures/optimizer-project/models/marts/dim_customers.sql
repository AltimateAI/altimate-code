with customers as (

    select distinct
        customer_id,
        customer_name,
        region,
        signed_up_at
    from {{ ref('raw_customers') }}

)

select * from customers
