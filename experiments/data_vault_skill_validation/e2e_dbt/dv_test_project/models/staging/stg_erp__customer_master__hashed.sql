{{ config(materialized='view') }}

WITH s AS (
    SELECT * FROM {{ ref('stg_erp__customer_master') }}
)
SELECT
    cust_no                                       AS customer_bk,
    {{ dv_hash_bk(['cust_no']) }}                 AS customer_hk,
    legal_name,
    tax_id,
    country_code,
    updated_at                                    AS source_updated_at,
    CAST('{{ run_started_at }}' AS TIMESTAMP)     AS load_dts,
    'erp.customer_master'                         AS record_source,
    '{{ invocation_id }}'                         AS load_batch_id
FROM s
