with arrivals as (

    select * from {{ ref('base_arrivals__malaysia') }}

),

airports as (

    select * from {{ ref('base_airports') }}

),

-- Filter to non-codeshare flights on the most recent available date
filtered_arrivals as (

    select
        arrival_iata,
        arrival_date,
        is_code_share

    from
        arrivals

    where
        is_code_share is false
        or is_code_share is null

),

-- Get most recent date
max_date as (

    select max(arrival_date) as latest_date from filtered_arrivals

),

-- Count flights per airport on latest date
flight_counts as (

    select
        fa.arrival_iata,
        count(*) as flight_count

    from
        filtered_arrivals fa

        cross join
            max_date md

    where
        fa.arrival_date = md.latest_date

    group by
        1

),

-- Join with airports to get location data
final as (

    select
        a.airport_id,
        a.name,
        a.latitude,
        a.longitude,
        fc.flight_count

    from
        flight_counts fc

        inner join
            airports a
                on fc.arrival_iata = a.iata

    where
        a.country = 'Malaysia'

    order by
        a.name

)

select * from final
