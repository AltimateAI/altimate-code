{{ config(materialized='view') }}

WITH s AS (
    SELECT * FROM {{ ref('stg_wms__inventory') }}
)
SELECT
    store_id                                                    AS store_id_bk,
    sku                                                         AS sku_bk,
    quantity,
    {{ dv_hash_bk(['store_id', 'sku']) }}                       AS inventory_item_hk,
    CAST('{{ run_started_at }}' AS TIMESTAMP)                   AS load_dts,
    'wms.inventory'                                             AS record_source,
    '{{ invocation_id }}'                                       AS load_batch_id
FROM s
