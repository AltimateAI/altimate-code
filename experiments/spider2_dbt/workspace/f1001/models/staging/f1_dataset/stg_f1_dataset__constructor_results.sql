with 

source as (

    select * from {{ source('f1_dataset', 'constructor_results') }}

),

renamed as (

    select
        constructorresultsid,
        raceid,
        constructorid,
        points,
        status

    from source

)

select * from renamed
