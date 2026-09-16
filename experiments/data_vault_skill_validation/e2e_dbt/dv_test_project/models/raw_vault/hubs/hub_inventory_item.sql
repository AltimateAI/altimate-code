{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='inventory_item_hk',
    on_schema_change='fail'
) }}

WITH source AS (
    SELECT
        inventory_item_hk,
        store_id_bk,
        sku_bk,
        load_dts,
        record_source
    FROM {{ ref('stg_wms__inventory__hashed') }}
    WHERE store_id_bk IS NOT NULL AND sku_bk IS NOT NULL
),
deduped AS (
    SELECT * FROM source
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY inventory_item_hk
        ORDER BY load_dts, record_source
    ) = 1
)
SELECT * FROM deduped
{% if is_incremental() %}
WHERE inventory_item_hk NOT IN (SELECT inventory_item_hk FROM {{ this }})
{% endif %}
