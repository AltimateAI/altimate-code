{{ config(materialized='view') }}

WITH s AS (
    SELECT * FROM {{ ref('stg_ecommerce__orders') }}
)
SELECT
    order_id                                          AS order_bk,
    customer_id,
    order_status,
    total_cents,
    placed_at,
    {{ dv_hash_bk(['order_id']) }}                    AS order_hk,
    {{ dv_hash_bk(['customer_id']) }}                 AS customer_hk,
    {{ dv_hash_bk(['order_id', 'customer_id']) }}     AS lnk_order_customer_hk,
    {{ dv_hashdiff(['order_status', 'total_cents']) }} AS order_status_hashdiff,
    CAST('{{ run_started_at }}' AS TIMESTAMP)         AS load_dts,
    'ecommerce.orders'                                AS record_source,
    '{{ invocation_id }}'                             AS load_batch_id
FROM s
