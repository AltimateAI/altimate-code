{{ config(materialized='table') }}

with daily as (
    select
        record_id,
        damage_euro,
        bike_type,
        crime_period_start_datetime,
        crime_period_end_datetime,
        plr_id,
        'daily' as source_type
    from {{ ref('stg_theft_reports_daily') }}
),

archived as (
    select
        record_id,
        damage_euro,
        bike_type,
        crime_period_start_datetime,
        crime_period_end_datetime,
        plr_id,
        'archive' as source_type
    from {{ ref('stg_theft_reports_archived') }}
),

combined as (
    select * from daily
    union all
    select * from archived
),

geo as (
    select
        plr_id,
        bezirk_id,
        bezirk_name,
        pgr_id,
        pgr_name,
        plr_name,
        plr_geometry,
        stand
    from {{ ref('stg_berlin_lor_geo') }}
)

select
    -- identifiers
    combined.record_id,

    -- theft metrics
    combined.damage_euro,
    combined.bike_type,
    combined.crime_period_start_datetime,
    combined.crime_period_end_datetime,
    combined.source_type,

    -- crime location geographic details
    geo.bezirk_id   as crime_location_bezirk_id,
    geo.bezirk_name as crime_location_bezirk_name,
    geo.pgr_id      as crime_location_pgr_id,
    geo.pgr_name    as crime_location_pgr_name,
    geo.plr_id      as crime_location_plr_id,
    geo.plr_name    as crime_location_plr_name,
    geo.plr_geometry            as berlin_plr_geometry,
    geo.stand                   as berlin_plr_geometry_reference_date

from combined
left join geo
    on combined.plr_id = geo.plr_id
