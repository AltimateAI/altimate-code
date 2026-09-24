{{ config(materialized='view') }}

-- Stage 1: source mirror + hard-rule casts only.
WITH source AS (
    SELECT * FROM {{ source('raw', var('crm_customers_table')) }}
),
typed AS (
    SELECT
        CAST(customer_id AS VARCHAR)  AS customer_id,
        CAST(first_name  AS VARCHAR)  AS first_name,
        CAST(last_name   AS VARCHAR)  AS last_name,
        CAST(email       AS VARCHAR)  AS email,
        CAST(phone       AS VARCHAR)  AS phone,
        CAST(updated_at  AS TIMESTAMP) AS updated_at
    FROM source
)
SELECT * FROM typed
