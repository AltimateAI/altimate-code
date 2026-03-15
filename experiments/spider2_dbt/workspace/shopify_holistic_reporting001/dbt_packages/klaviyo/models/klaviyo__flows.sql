with flow as (

    select *
    from {{ var('flow') }}
),

flow_metrics as (

    select *
    from {{ ref('int_klaviyo__campaign_flow_metrics') }}
),

flow_join as (
    
    {% set exclude_fields = ['last_touch_campaign_id', 'last_touch_flow_id', 'source_relation'] %}

    select
        flow.*, -- has flow_id and source_relation
        {{ dbt_utils.star(from=ref('int_klaviyo__campaign_flow_metrics'), except=exclude_fields) }}

    from flow
    left join flow_metrics on (
      flow.flow_id = flow_metrics.last_touch_flow_id
      and
      flow.source_relation = flow_metrics.source_relation
    )
),

final as (

    select 
        *,
        {{ dbt_utils.generate_surrogate_key(['flow_id','variation_id']) }} as flow_variation_key

    from flow_join
)

select *
from final