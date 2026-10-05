{{ config(materialized='view') }}

WITH source AS (
    SELECT * FROM {{ source('raw', 'raw_ecommerce_orders') }}
)
SELECT
    CAST(order_id     AS VARCHAR)   AS order_id,
    CAST(customer_id  AS VARCHAR)   AS customer_id,
    CAST(order_status AS VARCHAR)   AS order_status,
    CAST(total_cents  AS INTEGER)   AS total_cents,
    CAST(placed_at    AS TIMESTAMP) AS placed_at
FROM source
