{{ config(materialized="table", tags="dim") }}

WITH customer AS (
    SELECT customer_id,
           customer_first_name,
           customer_last_name,
           customer_company,
           customer_address,
           customer_city,
           customer_state,
           customer_country,
           customer_postal_code,
           customer_phone,
           customer_fax,
           customer_email,
           employee_id
      FROM {{ ref('stg_customer') }}
),

employee AS (
    SELECT employee_id,
           employee_first_name,
           employee_last_name
      FROM {{ ref('stg_employee') }}
)

SELECT customer.customer_id,
       customer.customer_first_name,
       customer.customer_last_name,
       customer.customer_company,
       customer.customer_address,
       customer.customer_city,
       customer.customer_state,
       customer.customer_country,
       customer.customer_postal_code,
       customer.customer_phone,
       customer.customer_fax,
       customer.customer_email,
       customer.employee_id,
       employee.employee_first_name AS support_rep_first_name,
       employee.employee_last_name  AS support_rep_last_name
  FROM customer
  LEFT JOIN employee ON customer.employee_id = employee.employee_id
