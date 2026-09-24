{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='lnk_customer_am_hk',
    on_schema_change='fail'
) }}

WITH source AS (
    SELECT
        lnk_customer_am_hk,
        customer_hk,
        account_manager_hk,
        load_dts,
        record_source
    FROM {{ ref('stg_crm__account_manager__hashed') }}
    WHERE customer_id IS NOT NULL
      AND account_manager_id IS NOT NULL
),
deduped AS (
    SELECT * FROM source
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY lnk_customer_am_hk ORDER BY load_dts, record_source
    ) = 1
)
SELECT * FROM deduped
{% if is_incremental() %}
WHERE lnk_customer_am_hk NOT IN (SELECT lnk_customer_am_hk FROM {{ this }})
{% endif %}
