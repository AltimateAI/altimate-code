select
    id as order_id,
    customer_id,
    order_date,
    amount
from {{ ref('raw_orders') }}
