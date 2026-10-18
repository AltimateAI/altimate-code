select
    c.id as customer_id,
    c.name,
    count(o.order_id) as order_count,
    coalesce(sum(o.amount), 0) as total_amount,
    min(o.order_date) as first_order
from {{ ref('raw_customers') }} c
left join {{ ref('stg_orders') }} o on o.customer_id = c.id
group by 1, 2
