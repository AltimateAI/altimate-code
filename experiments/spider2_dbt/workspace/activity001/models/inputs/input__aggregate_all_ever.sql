{{ config(materialized='ephemeral') }}
select * from main.input__aggregate_all_ever
