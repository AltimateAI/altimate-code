{{ config(materialized='view') }}

-- Stage 2: hashed staging — computes vault-ready columns.
WITH s AS (
    SELECT * FROM {{ ref('stg_crm__customers') }}
),
hashed AS (
    SELECT
        customer_id AS customer_bk,
        {{ dv_hash_bk(['customer_id']) }} AS customer_hk,
        {{ dv_hashdiff(['email', 'first_name', 'last_name', 'phone']) }} AS customer_details_hashdiff,
        first_name,
        last_name,
        email,
        phone,
        updated_at                                    AS source_updated_at,
        CAST('{{ run_started_at }}' AS TIMESTAMP)     AS load_dts,
        'crm.customers'                               AS record_source,
        '{{ invocation_id }}'                         AS load_batch_id
    FROM s
)
SELECT * FROM hashed
