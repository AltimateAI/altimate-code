-- dataset__aggregate_after_1
-- Compares users who signed up (primary activity) with how many times
-- they visited a page AFTER signing up (aggregate_after method).
-- Primary activity: signed up (all_ever)
-- Appended activity: visit page (aggregate_after) - counts visit page events after signed up

with primary_activity as (
    select
        activity_id,
        entity_uuid,
        ts,
        revenue_impact
    from {{ ref("input__aggregate_after") }}
    where activity = 'signed up'
),

appended_activity as (
    select
        entity_uuid,
        count(activity_id) as aggregate_after_visit_page_activity_id
    from {{ ref("input__aggregate_after") }}
    where activity = 'visit page'
    group by entity_uuid
),

final as (
    select
        p.activity_id,
        p.entity_uuid,
        p.ts,
        p.revenue_impact,
        coalesce(
            (
                select count(a.activity_id)
                from {{ ref("input__aggregate_after") }} a
                where a.activity = 'visit page'
                  and a.entity_uuid = p.entity_uuid
                  and a.ts > p.ts
            ),
            0
        ) as aggregate_after_visit_page_activity_id
    from primary_activity p
)

select * from final
