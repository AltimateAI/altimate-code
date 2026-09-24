{{ config(materialized='view') }}

WITH s AS (
    SELECT * FROM {{ ref('stg_crm__account_manager') }}
)
SELECT
    customer_id,
    account_manager_id,
    assigned_at,
    {{ dv_hash_bk(['customer_id']) }}                            AS customer_hk,
    {{ dv_hash_bk(['account_manager_id']) }}                     AS account_manager_hk,
    {{ dv_hash_bk(['customer_id', 'account_manager_id']) }}      AS lnk_customer_am_hk,
    CAST('{{ run_started_at }}' AS TIMESTAMP)                    AS load_dts,
    'crm.account_manager'                                        AS record_source,
    '{{ invocation_id }}'                                        AS load_batch_id
FROM s
