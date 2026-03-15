{{ config(enabled=var('greenhouse_using_app_history', True)) }}

with application_history as (

    select *
    from {{ ref('stg_greenhouse__application_history') }}
),

-- enrich with job stage names
job_stage as (

    select *
    from {{ ref('stg_greenhouse__job_stage') }}
),

-- enrich with application-level info (candidate name, recruiter, job info, etc.)
application as (

    select *
    from {{ ref('int_greenhouse__application_info') }}
),

-- calculate valid_until as the next stage transition for the same application
windowed as (

    select
        application_history.*,
        lead(application_history.updated_at) over (
            partition by application_history.application_id 
            order by application_history.updated_at
        ) as valid_until
    from application_history
),

-- count activities per candidate during each stage window
activity as (

    select *
    from {{ ref('stg_greenhouse__activity') }}
),

-- join activity counts per stage window
activity_in_stage as (

    select
        windowed.application_id,
        windowed.updated_at as valid_from,
        count(activity.activity_id) as count_activities_in_stage
    from windowed
    left join application
        on windowed.application_id = application.application_id
    left join activity
        on application.candidate_id = activity.candidate_id
        and activity.occurred_at >= windowed.updated_at
        and (activity.occurred_at < windowed.valid_until or windowed.valid_until is null)
    group by 1, 2
),

final as (

    select
        windowed.application_id,
        windowed.new_stage_id,
        windowed.new_status,
        windowed.updated_at as valid_from,
        windowed.valid_until,
        job_stage.stage_name as new_stage,

        application.full_name,
        application.status as current_status,
        application.recruiter_name,
        application.hiring_managers,
        application.sourced_from,
        application.sourced_from_type,
        application.job_title,
        application.job_departments,
        application.job_parent_departments,
        application.job_offices,
        application.job_id,
        application.candidate_id

        {% if var('greenhouse_using_eeoc', true) %}
        ,
        application.candidate_gender,
        application.candidate_disability_status,
        application.candidate_race,
        application.candidate_veteran_status
        {% endif %}

        ,
        {{ dbt.datediff('windowed.updated_at', 'coalesce(windowed.valid_until, current_timestamp)', 'day') }} as days_in_stage,
        coalesce(activity_in_stage.count_activities_in_stage, 0) as count_activities_in_stage

    from windowed
    left join job_stage
        on windowed.new_stage_id = job_stage.job_stage_id
    left join application
        on windowed.application_id = application.application_id
    left join activity_in_stage
        on windowed.application_id = activity_in_stage.application_id
        and windowed.updated_at = activity_in_stage.valid_from
)

select *
from final
