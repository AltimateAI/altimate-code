{{ config(materialized='view') }}

WITH source AS (
    SELECT * FROM {{ source('raw', 'raw_erp_customer_master') }}
)
SELECT
    CAST(cust_no      AS VARCHAR)   AS cust_no,
    CAST(legal_name   AS VARCHAR)   AS legal_name,
    CAST(tax_id       AS VARCHAR)   AS tax_id,
    CAST(country_code AS VARCHAR)   AS country_code,
    CAST(updated_at   AS TIMESTAMP) AS updated_at
FROM source
