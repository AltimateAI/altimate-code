{{ config(materialized='view') }}

WITH source AS (
    SELECT * FROM {{ source('raw', 'raw_wms_inventory') }}
)
SELECT
    CAST(store_id  AS VARCHAR)   AS store_id,
    CAST(sku       AS VARCHAR)   AS sku,
    CAST(quantity  AS INTEGER)   AS quantity,
    CAST(updated_at AS TIMESTAMP) AS updated_at
FROM source
