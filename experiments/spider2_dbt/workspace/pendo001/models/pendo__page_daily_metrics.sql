with spine as (

    select *
    from {{ ref('int_pendo__calendar_spine') }}
),

daily_metrics as (

    select *
    from {{ ref('int_pendo__page_daily_metrics') }}
),

page as (

    select 
        *,
        cast( {{ dbt.date_trunc('day', 'created_at') }} as date) as created_on,
        cast( {{ dbt.date_trunc('day', 'last_pageview_at') }} as date) as last_pageview_on

    from {{ ref('pendo__page') }}
),

page_spine as (

    select 
        spine.date_day,
        page.page_id,
        page.page_name,
        page.group_id,
        page.product_area_name
    
    from spine 
    join page
        on spine.date_day >= page.created_on
        and spine.date_day <= cast( {{ ['page.valid_through', 'page.last_pageview_on'] | max }} as date)

),

final as (

    select
        page_spine.date_day,
        page_spine.page_id,
        page_spine.page_name,
        page_spine.group_id,
        page_spine.product_area_name,

        coalesce(daily_metrics.sum_pageviews, 0) as sum_pageviews,
        coalesce(daily_metrics.count_visitors, 0) as count_visitors,
        coalesce(daily_metrics.count_accounts, 0) as count_accounts,
        coalesce(daily_metrics.count_first_time_visitors, 0) as count_first_time_visitors,
        coalesce(daily_metrics.count_first_time_accounts, 0) as count_first_time_accounts,
        coalesce(daily_metrics.count_return_visitors, 0) as count_return_visitors,
        coalesce(daily_metrics.count_return_accounts, 0) as count_return_accounts,
        coalesce(daily_metrics.avg_daily_minutes_per_visitor, 0) as avg_daily_minutes_per_visitor,
        coalesce(daily_metrics.avg_daily_pageviews_per_visitor, 0) as avg_daily_pageviews_per_visitor,
        coalesce(daily_metrics.percent_of_daily_pageviews, 0) as percent_of_daily_pageviews,
        coalesce(daily_metrics.percent_of_daily_page_visitors, 0) as percent_of_daily_page_visitors,
        coalesce(daily_metrics.percent_of_daily_page_accounts, 0) as percent_of_daily_page_accounts,
        coalesce(daily_metrics.count_pageview_events, 0) as count_pageview_events

    from page_spine
    left join daily_metrics
        on page_spine.date_day = daily_metrics.occurred_on
        and page_spine.page_id = daily_metrics.page_id
)

select *
from final
