{{ config(materialized="table", tags="fact") }}

SELECT invoice_id,
       customer_id,
       invoice_date,
       invoice_billing_address,
       invoice_billing_city,
       invoice_billing_state,
       invoice_billing_country,
       invoice_billing_postal_code,
       invoice_total
  FROM {{ ref('stg_invoice') }}
