with organization_role_data as (

    select
        organization_id,
        organization_role_id,
        organization_role_code,
        source_relation
    from {{ ref('stg_workday__organization_role') }}
),

position_organization_data as (

    select
        organization_id,
        position_id,
        source_relation
    from {{ ref('stg_workday__position_organization') }}
),

worker_position_organization_data as (

    select
        organization_id,
        position_id,
        worker_id,
        source_relation
    from {{ ref('stg_workday__worker_position_organization') }}
),

organization_data as (

    select
        organization_id,
        source_relation,
        organization_code,
        organization_name,
        organization_type,
        organization_sub_type,
        superior_organization_id,
        top_level_organization_id,
        manager_id
    from {{ ref('stg_workday__organization') }}
),

organization_overview as (

    select
        organization_role_data.organization_id,
        organization_role_data.organization_role_id,
        position_organization_data.position_id,
        worker_position_organization_data.worker_id,
        organization_role_data.source_relation,
        organization_data.organization_code,
        organization_data.organization_name,
        organization_data.organization_type,
        organization_data.organization_sub_type,
        organization_data.superior_organization_id,
        organization_data.top_level_organization_id,
        organization_data.manager_id,
        organization_role_data.organization_role_code
    from organization_role_data
    left join position_organization_data
        on organization_role_data.organization_id = position_organization_data.organization_id
        and organization_role_data.source_relation = position_organization_data.source_relation
    left join worker_position_organization_data
        on position_organization_data.organization_id = worker_position_organization_data.organization_id
        and position_organization_data.position_id = worker_position_organization_data.position_id
        and organization_role_data.source_relation = worker_position_organization_data.source_relation
    left join organization_data
        on organization_role_data.organization_id = organization_data.organization_id
        and organization_role_data.source_relation = organization_data.source_relation
)

select *
from organization_overview
