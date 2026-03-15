with application as (

    select *
    from {{ ref('int_greenhouse__application_info') }}
),

-- interview data for counting stats (use interview_users to get interviewer_name)
interview as (

    select *
    from {{ ref('int_greenhouse__interview_users') }}
),

-- aggregate interview metrics per application
interview_agg as (

    select
        application_id,
        count(distinct scheduled_interview_id) as count_interviews,
        count(scorecard_id) as count_interview_scorecards,
        count(distinct interviewer_user_id) as count_distinct_interviewers,
        max(start_at) as latest_interview_scheduled_at
    from interview
    group by 1
),

-- determine if any interviewer is a hiring manager for the job
-- we need job-level hiring manager info from application, which has hiring_managers column
-- and interview has interviewer_name; join back to get per-application flag
interview_w_hiring_manager as (

    select
        interview.application_id,
        max(
            case 
                when application.hiring_managers like ('%' || interview.interviewer_name || '%') 
                    and interview.interviewer_name is not null
                then 1 
                else 0 
            end
        ) as has_interviewed_w_hiring_manager

    from interview
    join application
        on interview.application_id = application.application_id
    group by 1
),

final as (

    select
        application.applied_at,
        application.candidate_id,
        application.credited_to_user_id,
        application.current_stage_id,
        application.application_id,
        application.last_activity_at,
        application.location_address,
        application.is_prospect,
        application.prospect_owner_user_id,
        application.prospect_pool_id,
        application.prospect_stage_id,
        application.rejected_at,
        application.rejected_reason_id,
        application.source_id,
        application.status,
        application.referrer_name,
        application.prospect_owner_name,
        application.current_company,
        application.coordinator_user_id,
        application.candidate_created_at,
        application.full_name,
        application.is_private,
        application.recruiter_user_id,
        application.current_title,
        application.last_updated_at,
        application.phone,
        application.email,
        application.resume_url,
        application.linkedin_url,
        application.github_url,
        application.coordinator_name,
        application.recruiter_name,
        application.coordinator_email,
        application.recruiter_email,
        application.candidate_tags,
        application.current_job_stage,
        application.sourced_from,
        application.sourced_from_type,
        application.count_activities,
        application.job_title,
        application.job_offices,
        application.job_departments,
        application.job_parent_departments,
        application.job_status,
        application.hiring_managers,
        application.job_id,
        application.job_requisition_id,
        application.job_sourcers,
        application.prospect_pool,
        application.prospect_stage,
        application.candidate_gender,
        application.candidate_disability_status,
        application.candidate_race,
        application.candidate_veteran_status,
        application.application_job_key,

        coalesce(interview_w_hiring_manager.has_interviewed_w_hiring_manager, 0) = 1 as has_interviewed_w_hiring_manager,
        coalesce(interview_agg.count_interviews, 0) as count_interviews,
        coalesce(interview_agg.count_interview_scorecards, 0) as count_interview_scorecards,
        coalesce(interview_agg.count_distinct_interviewers, 0) as count_distinct_interviewers,
        interview_agg.latest_interview_scheduled_at

    from application
    left join interview_agg
        on application.application_id = interview_agg.application_id
    left join interview_w_hiring_manager
        on application.application_id = interview_w_hiring_manager.application_id
)

select *
from final
