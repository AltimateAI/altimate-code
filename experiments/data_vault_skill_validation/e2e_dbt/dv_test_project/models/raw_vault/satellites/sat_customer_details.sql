{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key=['customer_hk', 'load_dts'],
    on_schema_change='fail'
) }}

WITH hashed AS (
    SELECT
        customer_hk,
        customer_details_hashdiff AS hashdiff,
        load_dts,
        record_source,
        first_name,
        last_name,
        email,
        phone
    FROM {{ ref('stg_crm__customers__hashed') }}
    WHERE customer_bk IS NOT NULL
    -- Dedupe duplicate source rows so satellite PK (parent_hk, load_dts)
    -- stays unique when the source feed has copies of the same row.
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY customer_hk, load_dts, customer_details_hashdiff
        ORDER BY record_source
    ) = 1
),

{% if is_incremental() %}
latest_in_target AS (
    SELECT customer_hk, hashdiff AS latest_hashdiff
    FROM {{ this }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY customer_hk ORDER BY load_dts DESC) = 1
),
{% endif %}

to_load AS (
    SELECT h.*
    FROM hashed h
    {% if is_incremental() %}
    LEFT JOIN latest_in_target l USING (customer_hk)
    WHERE l.customer_hk IS NULL
       OR l.latest_hashdiff <> h.hashdiff
    {% endif %}
)

SELECT * FROM to_load
