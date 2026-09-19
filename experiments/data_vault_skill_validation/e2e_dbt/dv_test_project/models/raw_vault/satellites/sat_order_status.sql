{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key=['order_hk', 'load_dts'],
    on_schema_change='fail'
) }}

WITH hashed AS (
    SELECT
        order_hk,
        order_status_hashdiff AS hashdiff,
        load_dts,
        record_source,
        order_status,
        total_cents
    FROM {{ ref('stg_ecommerce__orders__hashed') }}
    WHERE order_bk IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY order_hk, load_dts, order_status_hashdiff
        ORDER BY record_source
    ) = 1
),

{% if is_incremental() %}
latest_in_target AS (
    SELECT order_hk, hashdiff AS latest_hashdiff
    FROM {{ this }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY order_hk ORDER BY load_dts DESC) = 1
),
{% endif %}

to_load AS (
    SELECT h.*
    FROM hashed h
    {% if is_incremental() %}
    LEFT JOIN latest_in_target l USING (order_hk)
    WHERE l.order_hk IS NULL
       OR l.latest_hashdiff <> h.hashdiff
    {% endif %}
)

SELECT * FROM to_load
