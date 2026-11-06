{{ config(materialized='table') }}

-- Simple PIT: one row per (customer_hk, snapshot_dts) with the latest
-- sat_customer_details load_dts as of that snapshot.
-- For test purposes we build one snapshot per distinct load_dts that ever
-- appeared in sat_customer_details.

WITH snapshots AS (
    SELECT DISTINCT load_dts AS snapshot_dts FROM {{ ref('sat_customer_details') }}
),
cross_hub AS (
    SELECT h.customer_hk, s.snapshot_dts
    FROM {{ ref('hub_customer') }} h
    CROSS JOIN snapshots s
),
sat_asof AS (
    SELECT
        c.customer_hk,
        c.snapshot_dts,
        d.load_dts AS sat_customer_details_load_dts
    FROM cross_hub c
    LEFT JOIN {{ ref('sat_customer_details') }} d
        ON d.customer_hk = c.customer_hk
       AND d.load_dts <= c.snapshot_dts
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY c.customer_hk, c.snapshot_dts
        ORDER BY d.load_dts DESC NULLS LAST
    ) = 1
)
SELECT * FROM sat_asof
