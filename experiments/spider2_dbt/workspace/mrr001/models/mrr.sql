
with unioned as (

    select * from {{ ref('customer_revenue_by_month') }}

    union all

    select * from {{ ref('customer_churn_month') }}

),

lagged_values as (
    select
        *,
        coalesce(
            lag(is_active) over (partition by customer_id order by date_month),
            false
        ) as previous_month_is_active,
        coalesce(
            lag(mrr) over (partition by customer_id order by date_month),
            0
        ) as previous_month_mrr
    from unioned
),

final as (
    select
        date_month,
        customer_id,
        mrr,
        is_active,
        first_active_month,
        last_active_month,
        is_first_month,
        is_last_month,
        previous_month_is_active,
        previous_month_mrr,
        mrr - previous_month_mrr as mrr_change,

        case
            when is_first_month then 'new'
            when not is_active and previous_month_is_active then 'churn'
            when is_active and not previous_month_is_active and not is_first_month then 'reactivation'
            when is_active and mrr > previous_month_mrr then 'upgrade'
            when is_active and mrr < previous_month_mrr then 'downgrade'
            else null
        end as change_category

    from lagged_values
)

select * from final
