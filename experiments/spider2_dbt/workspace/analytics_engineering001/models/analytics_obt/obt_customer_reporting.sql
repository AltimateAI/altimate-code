WITH fpo AS (
    SELECT * FROM {{ ref('fact_purchase_order') }}
),

c AS (
    SELECT * FROM {{ ref('dim_customer') }}
),

e AS (
    SELECT * FROM {{ ref('dim_employees') }}
),

p AS (
    SELECT * FROM {{ ref('dim_products') }}
),

source AS (
    SELECT
        c.customer_id,
        c.company              AS customer_company,
        c.last_name            AS customer_last_name,
        c.first_name           AS customer_first_name,
        c.email_address        AS customer_email_address,
        c.job_title            AS customer_job_title,
        e.employee_id,
        e.company              AS employee_company,
        e.last_name            AS employee_last_name,
        e.first_name           AS employee_first_name,
        p.product_id,
        p.product_name,
        fpo.purchase_order_id,
        fpo.quantity,
        fpo.unit_cost,
        fpo.status_id,
        get_current_timestamp() AS insertion_timestamp
    FROM fpo
    LEFT JOIN c ON c.customer_id = fpo.customer_id
    LEFT JOIN e ON e.employee_id = fpo.employee_id
    LEFT JOIN p ON p.product_id = fpo.product_id
)

SELECT
    customer_id,
    customer_company,
    customer_last_name,
    customer_first_name,
    customer_email_address,
    customer_job_title,
    employee_id,
    employee_company,
    employee_last_name,
    employee_first_name,
    product_id,
    product_name,
    purchase_order_id,
    quantity,
    unit_cost,
    status_id,
    insertion_timestamp
FROM source
