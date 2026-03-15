-- Linear attribution: every touchpoint in the conversion path receives equal credit.
-- This model joins monthly linear attribution data with ad spend to compute CPA and ROAS.

with touches as (
    select * from {{ ref('attribution_touches') }}
),

spend as (
    select * from {{ source('playbook', 'ad_spend') }}
),

-- Aggregate linear attribution points and revenue by month and traffic source
monthly_attribution as (
    select
        date_trunc('month', started_at)::date as date_month,
        utm_source,
        sum(linear_points)  as attribution_points,
        sum(linear_revenue) as attribution_revenue
    from touches
    group by 1, 2
),

-- Aggregate ad spend by month and traffic source
monthly_spend as (
    select
        date_trunc('month', date_day)::date as date_month,
        utm_source,
        sum(spend) as total_spend
    from spend
    group by 1, 2
),

joined as (
    select
        a.date_month,
        a.utm_source,
        a.attribution_points,
        a.attribution_revenue,
        s.total_spend,
        s.total_spend / nullif(a.attribution_points, 0)  as cost_per_acquisition,
        a.attribution_revenue / nullif(s.total_spend, 0) as return_on_advertising_spend
    from monthly_attribution a
    inner join monthly_spend s
        on a.date_month = s.date_month
        and a.utm_source = s.utm_source
)

select * from joined
