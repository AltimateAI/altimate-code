{{ config(materialized='ephemeral') }}
select * from main.input__nth_ever
