{{ config(
    materialized='incremental',
    incremental_strategy='append',
    unique_key=['lnk_customer_am_hk', 'load_dts'],
    on_schema_change='fail'
) }}

-- Effectivity satellite tracking (customer, account_manager) intervals.
-- On each batch:
--   1. New link observations get "open" rows (effective_to = 9999-12-31).
--   2. Previously-open relationships not in current source get a "close" row.

WITH source_current AS (
    SELECT
        lnk_customer_am_hk,
        customer_hk,
        assigned_at                                  AS effective_from,
        CAST('9999-12-31' AS DATE)                   AS effective_to,
        load_dts,
        record_source
    FROM {{ ref('stg_crm__account_manager__hashed') }}
    WHERE customer_id IS NOT NULL
      AND account_manager_id IS NOT NULL
),

open_intervals AS (
    SELECT * FROM source_current
    {% if is_incremental() %}
    -- Only insert if we don't already have an OPEN row for this exact link hash.
    WHERE lnk_customer_am_hk NOT IN (
        SELECT lnk_customer_am_hk FROM {{ this }}
        WHERE effective_to = CAST('9999-12-31' AS DATE)
    )
    {% endif %}
)

{% if is_incremental() %},

-- Close any customer's currently-open link that isn't in this batch.
-- (i.e. the customer switched from AM-A to AM-B: (C, AM-A) had an open row;
--  in this batch only (C, AM-B) appears; we close (C, AM-A).)
close_intervals AS (
    SELECT
        existing.lnk_customer_am_hk,
        existing.customer_hk,
        existing.effective_from,
        CAST('{{ run_started_at }}' AS DATE)  AS effective_to,
        CAST('{{ run_started_at }}' AS TIMESTAMP) AS load_dts,
        'system.effectivity_close'            AS record_source
    FROM {{ this }} existing
    WHERE existing.effective_to = CAST('9999-12-31' AS DATE)
      AND existing.customer_hk IN (SELECT customer_hk FROM source_current)
      AND existing.lnk_customer_am_hk NOT IN (
          SELECT lnk_customer_am_hk FROM source_current
      )
)

SELECT * FROM open_intervals
UNION ALL
SELECT * FROM close_intervals
{% else %}

SELECT * FROM open_intervals
{% endif %}
