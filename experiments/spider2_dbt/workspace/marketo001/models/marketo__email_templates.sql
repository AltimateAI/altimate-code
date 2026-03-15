with email_template_history as (

    select *
    from {{ var('email_tempate_history') }}
    where is_most_recent_version = True

), email_stats as (

    select *
    from {{ ref('marketo__email_stats__by_email_template') }}

), joined as (

    select
        email_template_history.*,
        coalesce(email_stats.count_sends, 0) as count_sends,
        coalesce(email_stats.count_opens, 0) as count_opens,
        coalesce(email_stats.count_bounces, 0) as count_bounces,
        coalesce(email_stats.count_clicks, 0) as count_clicks,
        coalesce(email_stats.count_deliveries, 0) as count_deliveries,
        coalesce(email_stats.count_unsubscribes, 0) as count_unsubscribes,
        coalesce(email_stats.count_unique_opens, 0) as count_unique_opens,
        coalesce(email_stats.count_unique_clicks, 0) as count_unique_clicks
    from email_template_history
    left join email_stats
        using (email_template_id)

)

select *
from joined
