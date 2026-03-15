{{ config(materialized='ephemeral') }}
select * from main.input__first_in_between
