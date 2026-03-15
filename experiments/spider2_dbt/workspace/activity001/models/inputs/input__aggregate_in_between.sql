{{ config(materialized='ephemeral') }}
select * from main.input__aggregate_in_between
