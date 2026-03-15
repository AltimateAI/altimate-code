with 

source as (

    select * from {{ source('f1_dataset', 'status') }}

),

renamed as (

    select
        statusid,
        status

    from source

)

select * from renamed
