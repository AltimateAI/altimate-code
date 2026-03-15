-- dataset__aggregate_all_ever_1
-- Compares users who signed up (primary activity) with how many times
-- they EVER visited a page (aggregate_all_ever method).
-- Primary activity: signed up (all_ever)
-- Appended activity: visit page (aggregate_all_ever) - counts ALL visit page events regardless of timing

with primary_activity as (
    select
        activity_id,
        entity_uuid,
        ts,
        revenue_impact
    from {{ ref("input__aggregate_all_ever") }}
    where activity = 'signed up'
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
                from {{ ref("input__aggregate_all_ever") }} a
                where a.activity = 'visit page'
                  and a.entity_uuid = p.entity_uuid
            ),
            0
        ) as aggregate_all_ever_visit_page_activity_id
    from primary_activity p
)

select * from final
