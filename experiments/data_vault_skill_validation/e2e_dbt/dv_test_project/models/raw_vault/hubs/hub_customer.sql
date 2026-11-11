{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='customer_hk',
    on_schema_change='fail'
) }}

-- Hub: union of every source that mentions customer, deduped on hash key.
WITH crm AS (
    SELECT customer_hk, customer_bk, load_dts, record_source
    FROM {{ ref('stg_crm__customers__hashed') }}
    WHERE customer_bk IS NOT NULL
),
erp AS (
    SELECT customer_hk, customer_bk, load_dts, record_source
    FROM {{ ref('stg_erp__customer_master__hashed') }}
    WHERE customer_bk IS NOT NULL
),
orders AS (
    -- Customers observed via orders (a customer may appear in orders before we get the master feed)
    SELECT customer_hk,
           customer_id AS customer_bk,
           load_dts,
           record_source
    FROM {{ ref('stg_ecommerce__orders__hashed') }}
    WHERE customer_id IS NOT NULL
),
unioned AS (
    SELECT * FROM crm
    UNION ALL
    SELECT * FROM erp
    UNION ALL
    SELECT * FROM orders
),
deduped AS (
    SELECT customer_hk, customer_bk, load_dts, record_source
    FROM unioned
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY customer_hk
        ORDER BY load_dts, record_source
    ) = 1
)
SELECT * FROM deduped
{% if is_incremental() %}
WHERE customer_hk NOT IN (SELECT customer_hk FROM {{ this }})
{% endif %}
