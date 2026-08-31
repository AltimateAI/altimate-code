{{ config(materialized='table') }}

select *
from {{ ref('raw_events') }}
