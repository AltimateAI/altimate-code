{{ config(materialized='table') }}

select *
from {{ ref('stg_events') }}
where event_type is not null
