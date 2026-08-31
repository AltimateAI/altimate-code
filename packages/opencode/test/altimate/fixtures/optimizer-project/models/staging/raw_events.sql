{{ config(materialized='view') }}

select *
from (
    values
        (1, 'purchase', 101, timestamp '2026-08-01 10:00:00', 120.50),
        (2, 'refund',   101, timestamp '2026-08-01 11:00:00', 20.00),
        (3, 'purchase', 102, timestamp '2026-08-02 09:30:00', 75.00),
        (4, 'pageview', 103, timestamp '2026-08-02 09:45:00', 0.00),
        (5, 'purchase', 103, timestamp '2026-08-03 14:10:00', 220.00)
) as t(event_id, event_type, customer_id, loaded_at, amount_usd)
