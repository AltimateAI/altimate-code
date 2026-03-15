with drivers as (
  select driverId as driver_id,
         driverRef as driver_ref,
         number as driver_number,
         code as driver_code,
         forename as driver_first_name,
         surname as driver_last_name,
         dob as driver_date_of_birth,
         nationality as driver_nationality,
         url as driver_url,
         forename || ' ' || surname as driver_full_name,
         DATE_DIFF('year', dob, CURRENT_DATE) as driver_current_age

    from {{ source('f1_dataset', 'drivers') }}
)

select *
  from drivers
