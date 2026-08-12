{{ config(materialized='view') }}

select *
from (
    values
        (101, 'Acme Corp',  'US',   timestamp '2025-01-15 00:00:00'),
        (102, 'Globex GmbH', 'EU',  timestamp '2025-03-20 00:00:00'),
        (103, 'Initech KK', 'APAC', timestamp '2025-06-01 00:00:00')
) as t(customer_id, customer_name, region, signed_up_at)
