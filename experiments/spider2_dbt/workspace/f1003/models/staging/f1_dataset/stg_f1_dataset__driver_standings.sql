with 

source as (

    select * from {{ source('f1_dataset', 'driver_standings') }}

),

renamed as (

    select
        driverstandingsid,
        raceid,
        driverid,
        points,
        position,
        positiontext,
        wins

    from source

)

select * from renamed
