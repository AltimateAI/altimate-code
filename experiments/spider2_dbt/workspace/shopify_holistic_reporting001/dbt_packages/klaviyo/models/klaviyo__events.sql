{{
    config(
        materialized='incremental',
        unique_key='unique_event_id',
        partition_by={
            "field": "occurred_on",
            "data_type": "date"
        } if target.type == 'bigquery' else none,
        incremental_strategy = 'delete+insert' if target.type in ('snowflake', 'postgres', 'redshift', 'duckdb') else 'merge',
        file_format = 'delta'
    )
}}
-- ^ the incremental strategy is split into delete+insert for snowflake since there is a bit of
-- overlap in transformed data blocks for incremental runs (we look back an extra hour, see lines 23 - 30)
-- this configuration solution was taken from https://docs.getdbt.com/reference/resource-configs/snowflake-configs#merge-behavior-incremental-models

with events as (

    select *
    from {{ ref('int_klaviyo__event_attribution') }}

    {% if is_incremental() %}

    -- most events (from all kinds of integrations) at least once every hour
    where _fivetran_synced >= cast(coalesce( 
            (
                select {{ dbt.dateadd(datepart = 'hour', 
                                            interval = -1,
                                            from_date_or_timestamp = 'max(_fivetran_synced)' ) }}  
                from {{ this }}
            ), '2012-01-01') as {{ dbt.type_timestamp() }} ) -- klaviyo was founded in 2012, so let's default the min date to then
    {% endif %}
),

event_fields as (

    -- excluding some fields to rename them and/or make them null if needed
    {% set exclude_fields = ['touch_session', 'last_touch_id', 'session_start_at', 'session_event_type', 'type', 'session_touch_type'] %}
    -- as of the patch release of dbt-utils v0.7.3, the snowflake uppercasing is not needed anymore so we have deleted the snowflake conditional in the exclusion

    select 
        {{ dbt_utils.star(from=ref('int_klaviyo__event_attribution'), except=exclude_fields) }},

        type, -- need to pull this out because it gets removed by dbt_utils.star, due to being a substring of 'session_event_type' and 'session_touch_type'

        -- split out campaign and flow IDs
        case 
            when session_touch_type = 'campaign' then last_touch_id 
        else null end as last_touch_campaign_id,
        case 
            when session_touch_type = 'flow' then last_touch_id 
        else null end as last_touch_flow_id,

        -- only make these non-null if the event indeed qualified for attribution
        case 
            when last_touch_id is not null then session_start_at 
        else null end as last_touch_at,
        case 
            when last_touch_id is not null then session_event_type 
        else null end as last_touch_event_type,
        case 
            when last_touch_id is not null then session_touch_type 
        else null end as last_touch_type -- flow vs campaign

    
    from events
),

campaign as (

    select *
    from {{ var('campaign') }}
),

flow as (

    select *
    from {{ var('flow') }}
),

person as (

    select *
    from {{ var('person') }}
),

-- just pulling this to join with INTEGRATION
metric as (

    select *
    from {{ var('metric') }}
),

join_fields as (

    select
        event_fields.*,
        campaign.campaign_name,
        campaign.campaign_type,
        campaign.subject as campaign_subject_line,
        flow.flow_name, 
        person.city as person_city,
        person.country as person_country,
        person.region as person_region,
        person.email as person_email,
        person.timezone as person_timezone,
        metric.integration_id,
        metric.integration_name,
        metric.integration_category

    from event_fields
    left join campaign on (
      event_fields.last_touch_campaign_id = campaign.campaign_id
      and
      event_fields.source_relation = campaign.source_relation
    )
    left join flow on (
      event_fields.last_touch_flow_id = flow.flow_id
      and
      event_fields.source_relation = flow.source_relation  
    )
    left join person on (
      event_fields.person_id = person.person_id
      and
      event_fields.source_relation = person.source_relation
    )
    left join metric on (
      event_fields.metric_id = metric.metric_id
      and
      event_fields.source_relation = metric.source_relation
    )
)

select * from join_fields