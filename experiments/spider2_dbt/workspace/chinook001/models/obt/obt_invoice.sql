{{ config(materialized="table", tags="obt") }}

-- Pre-cast invoice_date to DATE to avoid function on join column
WITH invoice AS (
    SELECT invoice_id,
           customer_id,
           CAST(invoice_date AS DATE) AS invoice_date,
           invoice_billing_address,
           invoice_billing_city,
           invoice_billing_state,
           invoice_billing_country,
           invoice_billing_postal_code,
           invoice_total
      FROM {{ ref('fct_invoice') }}
)

SELECT
    -- Date dimension key
    dd.date_key,

    -- Invoice fields
    inv.invoice_id,
    inv.customer_id,
    inv.invoice_billing_address,
    inv.invoice_billing_city,
    inv.invoice_billing_state,
    inv.invoice_billing_country,
    inv.invoice_billing_postal_code,
    inv.invoice_total,

    -- Customer dimension fields
    dc.customer_first_name,
    dc.customer_last_name,
    dc.customer_company,
    dc.customer_address,
    dc.customer_city,
    dc.customer_state,
    dc.customer_country,
    dc.customer_postal_code,
    dc.customer_phone,
    dc.customer_fax,
    dc.customer_email,
    dc.employee_id,
    dc.support_rep_first_name,
    dc.support_rep_last_name,

    -- Date dimension fields
    dd.day_of_year,
    dd.week_key,
    dd.week_of_year,
    dd.day_of_week,
    dd.iso_day_of_week,
    dd.day_name,
    dd.first_day_of_week,
    dd.last_day_of_week,
    dd.month_key,
    dd.month_of_year,
    dd.day_of_month,
    dd.month_name_short,
    dd.month_name,
    dd.first_day_of_month,
    dd.last_day_of_month,
    dd.quarter_key,
    dd.quarter_of_year,
    dd.day_of_quarter,
    dd.quarter_desc_short,
    dd.quarter_desc,
    dd.first_day_of_quarter,
    dd.last_day_of_quarter,
    dd.year_key,
    dd.first_day_of_year,
    dd.last_day_of_year,
    dd.ordinal_weekday_of_month

FROM invoice inv
LEFT JOIN {{ ref('dim_customer') }} dc
    ON inv.customer_id = dc.customer_id
LEFT JOIN {{ ref('dim_date') }} dd
    ON inv.invoice_date = dd.date_key
