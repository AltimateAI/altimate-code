select
    cast(date_trunc('month', created) as date) as month,
    payment_method,
    count(*) as payments,
    sum(amount_cents) as total_cents
from {{ source('billing', 'payments') }}
group by 1, 2
order by 1, 2
