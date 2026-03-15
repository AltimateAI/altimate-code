{{ config(materialized='ephemeral') }}
select * from main.input__last_after
