with customers_dates as (
    select *
    from {{ ref('int_recharge__customer_daily_rollup') }}

), billing as (
    select *
    from {{ ref('recharge__billing_history') }}

), customer_details as (
    select 
        customer_id,
        first_charge_processed_at
    from {{ ref('recharge__customer_details') }}

-- Daily metrics aggregated per customer per day, only for successful orders/charges
), daily_aggs as (
    select
        customer_id,
        cast({{ dbt.date_trunc('day', 'charge_created_at') }} as date) as date_day,
        count(order_id) as no_of_orders,
        count(case when lower(order_type) = 'recurring' then 1 else null end) as recurring_orders,
        count(case when lower(order_type) != 'recurring' then 1 else null end) as one_time_orders,
        sum(charge_total_price) as total_charges,

        -- charge-level discount metrics (only for successful charges)
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
            then charge_total_discounts else 0 end) as charge_total_discounts_realized,
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
            then calculated_order_total_discounts else 0 end) as calculated_order_total_discounts_realized,

        -- tax metrics
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
            then charge_total_tax else 0 end) as charge_total_tax_realized,
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
            then calculated_order_total_tax else 0 end) as calculated_order_total_tax_realized,

        -- price metrics
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
            then charge_total_price else 0 end) as charge_total_price_realized,
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
            then calculated_order_total_price else 0 end) as calculated_order_total_price_realized,

        -- refund metrics
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
            then charge_total_refunds else 0 end) as charge_total_refunds_realized,
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
            then calculated_order_total_refunds else 0 end) as calculated_order_total_refunds_realized,

        -- line item totals
        sum(case when lower(order_status) not in ('error', 'cancelled', 'queued')
            then order_line_item_total else 0 end) as order_line_item_total_realized,
        sum(case when lower(order_status) not in ('error', 'cancelled', 'queued')
            then order_item_quantity else 0 end) as order_item_quantity_realized,

        -- recurring net amounts (price - refunds for recurring)
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
                  and lower(charge_type) = 'recurring'
            then charge_total_price - charge_total_refunds else 0 end)
            as charge_recurring_net_amount_realized,
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
                  and lower(charge_type) = 'recurring'
            then calculated_order_total_price - calculated_order_total_refunds else 0 end)
            as calculated_order_recurring_net_amount_realized,

        -- one-time net amounts (price - refunds for non-recurring / checkout)
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
                  and lower(charge_type) != 'recurring'
            then charge_total_price - charge_total_refunds else 0 end)
            as charge_one_time_net_amount_realized,
        sum(case when lower(charge_status) not in ('error', 'skipped', 'queued')
                  and lower(charge_type) != 'recurring'
            then calculated_order_total_price - calculated_order_total_refunds else 0 end)
            as calculated_order_one_time_net_amount_realized

    from billing
    group by 1, 2

-- Join the calendar spine (customer x date) with daily aggregates
), joined as (
    select 
        customers_dates.customer_id,
        cast(customers_dates.date_day as date) as date_day,
        customers_dates.date_week,
        customers_dates.date_month,
        customers_dates.date_year,
        coalesce(daily_aggs.no_of_orders, 0) as no_of_orders,
        coalesce(daily_aggs.recurring_orders, 0) as recurring_orders,
        coalesce(daily_aggs.one_time_orders, 0) as one_time_orders,
        coalesce(daily_aggs.total_charges, 0) as total_charges,
        coalesce(daily_aggs.charge_total_discounts_realized, 0) as charge_total_discounts_realized,
        coalesce(daily_aggs.calculated_order_total_discounts_realized, 0) as calculated_order_total_discounts_realized,
        coalesce(daily_aggs.charge_total_tax_realized, 0) as charge_total_tax_realized,
        coalesce(daily_aggs.calculated_order_total_tax_realized, 0) as calculated_order_total_tax_realized,
        coalesce(daily_aggs.charge_total_price_realized, 0) as charge_total_price_realized,
        coalesce(daily_aggs.calculated_order_total_price_realized, 0) as calculated_order_total_price_realized,
        coalesce(daily_aggs.charge_total_refunds_realized, 0) as charge_total_refunds_realized,
        coalesce(daily_aggs.calculated_order_total_refunds_realized, 0) as calculated_order_total_refunds_realized,
        coalesce(daily_aggs.order_line_item_total_realized, 0) as order_line_item_total_realized,
        coalesce(daily_aggs.order_item_quantity_realized, 0) as order_item_quantity_realized,
        coalesce(daily_aggs.charge_recurring_net_amount_realized, 0) as charge_recurring_net_amount_realized,
        coalesce(daily_aggs.calculated_order_recurring_net_amount_realized, 0) as calculated_order_recurring_net_amount_realized,
        coalesce(daily_aggs.charge_one_time_net_amount_realized, 0) as charge_one_time_net_amount_realized,
        coalesce(daily_aggs.calculated_order_one_time_net_amount_realized, 0) as calculated_order_one_time_net_amount_realized,
        customer_details.first_charge_processed_at
    from customers_dates
    left join daily_aggs
        on daily_aggs.customer_id = customers_dates.customer_id
        and daily_aggs.date_day = cast(customers_dates.date_day as date)
    left join customer_details
        on customer_details.customer_id = customers_dates.customer_id

-- Add running totals via window functions and active_months_to_date
), windowed as (
    select
        customer_id,
        date_day,
        date_week,
        date_month,
        date_year,
        no_of_orders,
        recurring_orders,
        one_time_orders,
        total_charges,
        charge_total_discounts_realized,
        sum(charge_total_discounts_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as charge_total_discounts_running_total,
        calculated_order_total_discounts_realized,
        sum(calculated_order_total_discounts_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as calculated_order_total_discounts_running_total,
        charge_total_tax_realized,
        sum(charge_total_tax_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as charge_total_tax_running_total,
        calculated_order_total_tax_realized,
        sum(calculated_order_total_tax_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as calculated_order_total_tax_running_total,
        charge_total_price_realized,
        sum(charge_total_price_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as charge_total_price_running_total,
        calculated_order_total_price_realized,
        sum(calculated_order_total_price_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as calculated_order_total_price_running_total,
        charge_total_refunds_realized,
        sum(charge_total_refunds_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as charge_total_refunds_running_total,
        calculated_order_total_refunds_realized,
        sum(calculated_order_total_refunds_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as calculated_order_total_refunds_running_total,
        order_line_item_total_realized,
        sum(order_line_item_total_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as order_line_item_total_running_total,
        order_item_quantity_realized,
        sum(order_item_quantity_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as order_item_quantity_running_total,
        -- active_months_to_date: days from first_charge to current date_day divided by 30
        round(cast(
            {{ dbt.datediff('first_charge_processed_at', 'date_day', 'day') }} / 30.0
        as {{ dbt.type_numeric() }}), 2) as active_months_to_date,
        charge_recurring_net_amount_realized,
        sum(charge_recurring_net_amount_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as charge_recurring_net_amount_running_total,
        charge_one_time_net_amount_realized,
        sum(charge_one_time_net_amount_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as charge_one_time_net_amount_running_total,
        calculated_order_recurring_net_amount_realized,
        sum(calculated_order_recurring_net_amount_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as calculated_order_recurring_net_amount_running_total,
        calculated_order_one_time_net_amount_realized,
        sum(calculated_order_one_time_net_amount_realized) over (
            partition by customer_id order by date_day
            rows between unbounded preceding and current row
        ) as calculated_order_one_time_net_amount_running_total
    from joined
)

select
    customer_id,
    date_day,
    date_week,
    date_month,
    date_year,
    no_of_orders,
    recurring_orders,
    one_time_orders,
    total_charges,
    charge_total_discounts_realized,
    charge_total_discounts_running_total,
    calculated_order_total_discounts_realized,
    calculated_order_total_discounts_running_total,
    charge_total_tax_realized,
    charge_total_tax_running_total,
    calculated_order_total_tax_realized,
    calculated_order_total_tax_running_total,
    charge_total_price_realized,
    charge_total_price_running_total,
    calculated_order_total_price_realized,
    calculated_order_total_price_running_total,
    charge_total_refunds_realized,
    charge_total_refunds_running_total,
    calculated_order_total_refunds_realized,
    calculated_order_total_refunds_running_total,
    order_line_item_total_realized,
    order_line_item_total_running_total,
    order_item_quantity_realized,
    order_item_quantity_running_total,
    active_months_to_date,
    charge_recurring_net_amount_realized,
    charge_recurring_net_amount_running_total,
    charge_one_time_net_amount_realized,
    charge_one_time_net_amount_running_total,
    calculated_order_recurring_net_amount_realized,
    calculated_order_recurring_net_amount_running_total,
    calculated_order_one_time_net_amount_realized,
    calculated_order_one_time_net_amount_running_total
from windowed
