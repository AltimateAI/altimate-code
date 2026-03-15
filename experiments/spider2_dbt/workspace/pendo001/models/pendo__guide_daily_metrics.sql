with spine as (

    select *
    from {{ ref('int_pendo__calendar_spine') }}
),

daily_metrics as (

    select *
    from {{ ref('int_pendo__guide_daily_metrics') }}
),

guide as (

    select
        guide_id,
        guide_name,
        cast( {{ dbt.date_trunc('day', 'created_at') }} as date) as created_on

    from {{ ref('int_pendo__guide_info') }}
),

guide_spine as (

    select 
        spine.date_day,
        guide.guide_id,
        guide.guide_name
    
    from spine 
    join guide
        on spine.date_day >= guide.created_on
        and spine.date_day <= cast( {{ dbt.current_timestamp_backcompat() }} as date)

),

final as (

    select
        guide_spine.date_day,
        guide_spine.guide_id,
        guide_spine.guide_name,
        coalesce(daily_metrics.count_visitors, 0) as count_visitors,
        coalesce(daily_metrics.count_accounts, 0) as count_accounts,
        coalesce(daily_metrics.count_guide_events, 0) as count_guide_events,
        coalesce(daily_metrics.count_first_time_visitors, 0) as count_first_time_visitors,
        coalesce(daily_metrics.count_first_time_accounts, 0) as count_first_time_accounts,
        coalesce(daily_metrics.count_visitors_guideSeen, 0) as count_visitors_guideSeen,
        coalesce(daily_metrics.count_visitors_guideDismissed, 0) as count_visitors_guideDismissed,
        coalesce(daily_metrics.count_visitors_guideActivity, 0) as count_visitors_guideActivity,
        coalesce(daily_metrics.count_visitors_guideAdvanced, 0) as count_visitors_guideAdvanced,
        coalesce(daily_metrics.count_visitors_guideTimeout, 0) as count_visitors_guideTimeout,
        coalesce(daily_metrics.count_visitors_guideSnoozed, 0) as count_visitors_guideSnoozed

    from guide_spine
    left join daily_metrics
        on guide_spine.date_day = daily_metrics.occurred_on
        and guide_spine.guide_id = daily_metrics.guide_id
)

select *
from final
