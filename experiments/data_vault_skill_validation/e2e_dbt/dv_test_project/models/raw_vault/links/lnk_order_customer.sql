{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='lnk_order_customer_hk',
    on_schema_change='fail'
) }}

WITH source AS (
    SELECT
        lnk_order_customer_hk,
        order_hk,
        customer_hk,
        load_dts,
        record_source
    FROM {{ ref('stg_ecommerce__orders__hashed') }}
    WHERE order_bk IS NOT NULL
      AND customer_id IS NOT NULL
),
deduped AS (
    SELECT
        lnk_order_customer_hk,
        order_hk,
        customer_hk,
        load_dts,
        record_source
    FROM source
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY lnk_order_customer_hk
        ORDER BY load_dts, record_source
    ) = 1
)
SELECT * FROM deduped
{% if is_incremental() %}
WHERE lnk_order_customer_hk NOT IN (SELECT lnk_order_customer_hk FROM {{ this }})
{% endif %}
