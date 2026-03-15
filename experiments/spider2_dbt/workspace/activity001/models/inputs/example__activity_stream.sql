{{ config(materialized='ephemeral') }}
select * from main.example__activity_stream
