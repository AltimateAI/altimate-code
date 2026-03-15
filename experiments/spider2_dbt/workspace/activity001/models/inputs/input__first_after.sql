{{ config(materialized='ephemeral') }}
select * from main.input__first_after
