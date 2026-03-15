-- Pass-through model to expose the order_data seed table
-- Required because var('order') in dbt_project.yml resolves to ref('order_data')
select *
from {{ source('recharge', 'order') }}
