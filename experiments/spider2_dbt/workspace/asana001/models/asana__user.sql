with user_task_metrics as (

    select *
    from {{ ref('int_asana__user_task_metrics') }}
),

asana_user as (

    select *
    from {{ var('user') }}
),

project_user as (

    select *
    from {{ ref('int_asana__project_user') }}
),

-- Count projects owned by user (exclude archived, handled in int_asana__project_user which filters to non-archived)
count_projects_owned as (

    select
        user_id,
        count(distinct project_id) as number_of_projects_owned

    from project_user
    where role = 'owner'

    group by 1
),

-- Count projects where user currently has open tasks assigned
count_projects_assigned as (

    select
        user_id,
        count(distinct project_id) as number_of_projects_currently_assigned_to

    from project_user
    where role = 'task assignee'
      and currently_working_on

    group by 1
),

-- Aggregate list of projects user is actively working on or owns
agg_projects_working as (

    select
        user_id,
        {{ fivetran_utils.string_agg( 'distinct project_name', "', '" ) }} as projects_working_on

    from project_user
    where (role = 'owner') or (role = 'task assignee' and currently_working_on)

    group by 1
),

user_join as (

    select
        asana_user.user_id,
        asana_user.user_name,
        asana_user.email,
        coalesce(user_task_metrics.number_of_open_tasks, 0) as number_of_open_tasks,
        coalesce(user_task_metrics.number_of_tasks_completed, 0) as number_of_tasks_completed,
        round(user_task_metrics.avg_close_time_days, 0) as avg_close_time_days,
        coalesce(count_projects_owned.number_of_projects_owned, 0) as number_of_projects_owned,
        coalesce(count_projects_assigned.number_of_projects_currently_assigned_to, 0) as number_of_projects_currently_assigned_to,
        agg_projects_working.projects_working_on

    from
    asana_user
    left join user_task_metrics
        on asana_user.user_id = user_task_metrics.user_id
    left join count_projects_owned
        on asana_user.user_id = count_projects_owned.user_id
    left join count_projects_assigned
        on asana_user.user_id = count_projects_assigned.user_id
    left join agg_projects_working
        on asana_user.user_id = agg_projects_working.user_id

)

select * from user_join
