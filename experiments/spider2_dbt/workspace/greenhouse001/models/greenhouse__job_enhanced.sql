with job as (

    select *
    from {{ ref('int_greenhouse__job_info') }}
),

job_opening as (

    select *
    from {{ ref('stg_greenhouse__job_opening') }}
),

job_post as (

    select *
    from {{ ref('stg_greenhouse__job_post') }}
),

-- candidate applications (is_prospect = false)
application as (

    select *
    from {{ ref('stg_greenhouse__application') }}
),

job_application as (

    select *
    from {{ ref('stg_greenhouse__job_application') }}
),

-- interviews per application
scheduled_interview as (

    select *
    from {{ ref('stg_greenhouse__scheduled_interview') }}
),

-- aggregate application counts per job
app_counts as (

    select
        job_application.job_id,
        count(case when application.is_prospect = false and application.status = 'active' then application.application_id end) as count_active_applications,
        count(case when application.is_prospect = false and application.status = 'hired' then application.application_id end) as count_hired_applications,
        count(case when application.is_prospect = false and application.status = 'rejected' then application.application_id end) as count_rejected_applications,
        count(distinct case when application.is_prospect = false then application.application_id end) as count_total_applications,
        count(case when application.is_prospect = true and application.status = 'active' then application.application_id end) as count_active_prospects,
        count(case when application.is_prospect = true and application.status = 'rejected' then application.application_id end) as count_rejected_prospects,
        count(case when application.is_prospect = true and application.status != 'active' and application.status != 'rejected' then application.application_id end) as count_converted_prospects

    from job_application
    left join application
        on job_application.application_id = application.application_id
    group by 1
),

-- applications that received at least 1 interview
interviewed_apps as (

    select distinct job_application.job_id, scheduled_interview.application_id
    from scheduled_interview
    join job_application
        on scheduled_interview.application_id = job_application.application_id
),

count_interviewed as (

    select
        job_id,
        count(distinct application_id) as count_interviewed_applications
    from interviewed_apps
    group by 1
),

-- opening aggregates
opening_counts as (

    select
        job_id,
        count(case when current_status = 'open' then 1 end) as count_active_openings,
        count(case when current_status = 'closed' then 1 end) as count_closed_openings,
        count(case when current_status = 'closed' and application_id is not null then 1 end) as count_hired_closed_openings
    from job_opening
    group by 1
),

-- post aggregates
post_counts as (

    select
        job_id,
        count(case when is_live = true and is_internal = true then 1 end) as count_live_internal_posts,
        count(case when is_live = true and is_external = true then 1 end) as count_live_external_posts,
        count(distinct case when is_live = true then location_name end) as count_live_locations
    from job_post
    group by 1
),

final as (

    select
        job.last_opening_closed_at,
        job.is_confidential,
        job.created_at,
        job.job_id,
        job.job_title,
        job.notes,
        job.requisition_id,
        job.status,
        job.last_updated_at,
        job.hiring_managers,
        job.sourcers,
        job.recruiters,
        job.coordinators,
        job.offices,
        job.office_locations as locations,
        job.departments,
        job.parent_departments,

        coalesce(app_counts.count_active_applications, 0) as count_active_applications,
        coalesce(app_counts.count_hired_applications, 0) as count_hired_applications,
        coalesce(app_counts.count_rejected_applications, 0) as count_rejected_applications,
        coalesce(count_interviewed.count_interviewed_applications, 0) as count_interviewed_applications,
        coalesce(app_counts.count_active_prospects, 0) as count_active_prospects,
        coalesce(app_counts.count_converted_prospects, 0) as count_converted_prospects,
        coalesce(app_counts.count_rejected_prospects, 0) as count_rejected_prospects,
        coalesce(opening_counts.count_active_openings, 0) as count_active_openings,
        coalesce(opening_counts.count_closed_openings, 0) as count_closed_openings,
        coalesce(opening_counts.count_hired_closed_openings, 0) as count_hired_closed_openings,
        coalesce(post_counts.count_live_internal_posts, 0) as count_live_internal_posts,
        coalesce(post_counts.count_live_external_posts, 0) as count_live_external_posts,
        coalesce(post_counts.count_live_locations, 0) as count_live_locations

    from job
    left join app_counts
        on job.job_id = app_counts.job_id
    left join count_interviewed
        on job.job_id = count_interviewed.job_id
    left join opening_counts
        on job.job_id = opening_counts.job_id
    left join post_counts
        on job.job_id = post_counts.job_id
)

select *
from final
