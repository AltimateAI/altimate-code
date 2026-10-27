{{ config(materialized='view') }}

WITH source AS (
    SELECT * FROM {{ source('raw', var('am_table')) }}
)
SELECT
    CAST(customer_id        AS VARCHAR) AS customer_id,
    CAST(account_manager_id AS VARCHAR) AS account_manager_id,
    CAST(assigned_at        AS DATE)    AS assigned_at
FROM source
