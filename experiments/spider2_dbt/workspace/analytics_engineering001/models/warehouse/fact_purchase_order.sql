WITH po AS (
    SELECT * FROM {{ ref('stg_purchase_orders') }}
),

pod AS (
    SELECT * FROM {{ ref('stg_purchase_order_details') }}
),

ord AS (
    SELECT * FROM {{ ref('stg_orders') }}
),

-- Extract order_id from notes like "Purchase generated based on Order #41"
po_with_order AS (
    SELECT
        po.id AS purchase_order_id,
        po.supplier_id,
        po.created_by,
        po.submitted_date,
        po.creation_date,
        po.status_id,
        po.expected_date,
        po.shipping_fee,
        po.taxes,
        po.payment_date,
        po.payment_amount,
        po.payment_method,
        po.notes,
        po.approved_by,
        po.approved_date,
        po.submitted_by,
        TRY_CAST(REGEXP_EXTRACT(po.notes, '#([0-9]+)', 1) AS INTEGER) AS ref_order_id
    FROM po
),

source AS (
    SELECT
        ord.customer_id,
        ord.employee_id,
        pwo.purchase_order_id,
        pod.product_id,
        pod.quantity,
        pod.unit_cost,
        pod.date_received,
        pod.posted_to_inventory,
        pod.inventory_id,
        pwo.supplier_id,
        pwo.created_by,
        pwo.submitted_date,
        pwo.creation_date,
        pwo.status_id,
        pwo.expected_date,
        pwo.shipping_fee,
        pwo.taxes,
        pwo.payment_date,
        pwo.payment_amount,
        pwo.payment_method,
        pwo.notes,
        pwo.approved_by,
        pwo.approved_date,
        pwo.submitted_by,
        get_current_timestamp() AS insertion_timestamp
    FROM po_with_order pwo
    LEFT JOIN pod ON pod.purchase_order_id = pwo.purchase_order_id
    LEFT JOIN ord ON ord.id = pwo.ref_order_id
)

SELECT
    customer_id,
    employee_id,
    purchase_order_id,
    product_id,
    quantity,
    unit_cost,
    date_received,
    posted_to_inventory,
    inventory_id,
    supplier_id,
    created_by,
    submitted_date,
    creation_date,
    status_id,
    expected_date,
    shipping_fee,
    taxes,
    payment_date,
    payment_amount,
    payment_method,
    notes,
    approved_by,
    approved_date,
    submitted_by,
    insertion_timestamp
FROM source
