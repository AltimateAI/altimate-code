with overview_report as (

    select *
    from {{ ref('apple_store__overview_report') }}
),

subsetted as (

    select
        source_relation,
        date_day,
        'apple_store' as app_platform,
        app_name,
        sum(total_downloads) as downloads,
        sum(deletions) as deletions,
        sum(page_views) as page_views,
        sum(crashes) as crashes
    from overview_report
    {{ dbt_utils.group_by(4) }}
)

select *
from subsetted
