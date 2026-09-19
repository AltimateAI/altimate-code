{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key='account_manager_hk',
    on_schema_change='fail'
) }}

WITH source AS (
    SELECT
        account_manager_hk,
        account_manager_id AS account_manager_bk,
        load_dts,
        record_source
    FROM {{ ref('stg_crm__account_manager__hashed') }}
    WHERE account_manager_id IS NOT NULL
),
deduped AS (
    SELECT * FROM source
    QUALIFY ROW_NUMBER() OVER (PARTITION BY account_manager_hk ORDER BY load_dts) = 1
)
SELECT * FROM deduped
{% if is_incremental() %}
WHERE account_manager_hk NOT IN (SELECT account_manager_hk FROM {{ this }})
{% endif %}
