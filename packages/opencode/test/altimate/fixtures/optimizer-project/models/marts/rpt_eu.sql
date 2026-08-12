with revenue_base as (

    select
        e.customer_id,
        cast(e.loaded_at as date) as revenue_date,
        case
            when e.event_type = 'purchase' then e.amount_usd
            when e.event_type = 'refund' then -1 * e.amount_usd
            else 0
        end as net_amount_usd,
        case
            when e.event_type = 'purchase' then 1
            else 0
        end as is_purchase
    from {{ ref('stg_events') }} e
    where e.event_type in ('purchase', 'refund')

),

regional as (

    select
        r.customer_id,
        r.revenue_date,
        sum(r.net_amount_usd) as net_revenue_usd,
        sum(r.is_purchase) as purchase_count
    from revenue_base r
    inner join {{ ref('dim_customers') }} c on c.customer_id = r.customer_id
    where c.region = 'EU'
    group by r.customer_id, r.revenue_date

)

select * from regional
