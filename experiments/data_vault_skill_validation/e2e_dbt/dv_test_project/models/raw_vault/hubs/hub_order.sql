{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='order_hk',
    on_schema_change='fail'
) }}

WITH source AS (
    SELECT order_hk, order_bk, load_dts, record_source
    FROM {{ ref('stg_ecommerce__orders__hashed') }}
    WHERE order_bk IS NOT NULL
),
deduped AS (
    SELECT order_hk, order_bk, load_dts, record_source
    FROM source
    QUALIFY ROW_NUMBER() OVER (PARTITION BY order_hk ORDER BY load_dts) = 1
)
SELECT * FROM deduped
{% if is_incremental() %}
WHERE order_hk NOT IN (SELECT order_hk FROM {{ this }})
{% endif %}
