with team as (

    select *
    from {{ var('team') }}
),

asana_project as (

    select *
    from {{ ref('asana__project') }}
),

-- Aggregate task metrics and project counts per team
agg_team_projects as (

    select
        team_id,
        sum(number_of_open_tasks) as number_of_open_tasks,
        sum(number_of_assigned_open_tasks) as number_of_assigned_open_tasks,
        sum(number_of_tasks_completed) as number_of_tasks_completed,

        -- weighted average: sum of (avg * completed) / total completed
        -- asana__project stores avg_close_time_days = total_days_open / tasks_completed
        -- so sum(avg * completed) = total_days_open; divide by sum(completed) for proper weighted avg
        round(
            nullif(sum(coalesce(avg_close_time_days, 0) * number_of_tasks_completed), 0) * 1.0
            / nullif(sum(number_of_tasks_completed), 0),
            0
        ) as avg_close_time_days,

        round(
            nullif(sum(coalesce(avg_close_time_assigned_days, 0) * number_of_tasks_completed), 0) * 1.0
            / nullif(sum(number_of_tasks_completed), 0),
            0
        ) as avg_close_time_assigned_days,

        {{ fivetran_utils.string_agg( 'case when not is_archived then project_name else null end', "', '" ) }} as active_projects,
        sum(case when not is_archived then 1 else 0 end) as number_of_active_projects,
        sum(case when is_archived then 1 else 0 end) as number_of_archived_projects

    from asana_project
    group by 1
),

team_join as (

    select
        team.team_id,
        team.team_name,
        coalesce(agg_team_projects.number_of_open_tasks, 0) as number_of_open_tasks,
        coalesce(agg_team_projects.number_of_assigned_open_tasks, 0) as number_of_assigned_open_tasks,
        coalesce(agg_team_projects.number_of_tasks_completed, 0) as number_of_tasks_completed,
        agg_team_projects.avg_close_time_days,
        agg_team_projects.avg_close_time_assigned_days,
        agg_team_projects.active_projects,
        coalesce(agg_team_projects.number_of_active_projects, 0) as number_of_active_projects,
        coalesce(agg_team_projects.number_of_archived_projects, 0) as number_of_archived_projects

    from
    team
    left join agg_team_projects
        on team.team_id = agg_team_projects.team_id

)

select * from team_join
