with stg_distances as (

    select * from {{ ref('stg_airports__malaysia_distances') }}

),

pivoted as (

    select
        a_name,
        {{ get_b_name_columns() }}

    from
        stg_distances

    pivot (
        max(distance_km)
        for b_name in ({{ get_b_name_value() }})
    )

    order by
        a_name

)

select * from pivoted
