{{
    config(
        materialized='incremental',
        unique_key='unique_event_id',
        partition_by={
            "field": "occurred_on",
            "data_type": "date"
        } if target.type == 'bigquery' else none,
        incremental_strategy = 'delete+insert' if target.type in ('postgres', 'redshift', 'duckdb') else 'merge',
        file_format = 'delta'
    )
}}

with events as (

    select 
        *,
        -- no event will be attributed to both a campaign and flow
        coalesce(campaign_id, flow_id) as touch_id,
        case 
            when campaign_id is not null then 'campaign' 
            when flow_id is not null then 'flow' 
        else null end as touch_type -- defintion: touch = interaction with campaign/flow

    from {{ var('event_table') }}

    {% if is_incremental() %}
    -- grab **ALL** events for users who have any events in this new increment
    where person_id in (

        select distinct person_id
        from {{ var('event_table') }}

        -- most events (from all kinds of integrations) at least once every hour
        -- https://help.klaviyo.com/hc/en-us/articles/115005253208
        where _fivetran_synced >= cast(coalesce( 
            (
                select {{ dbt.dateadd(datepart = 'hour', 
                                            interval = -1,
                                            from_date_or_timestamp = 'max(_fivetran_synced)' ) }}  
                from {{ this }}
            ), '2012-01-01') as {{ dbt.type_timestamp() }} ) -- klaviyo was founded in 2012, so let's default the min date to then
    )
    {% endif %}
),

-- sessionize events based on attribution eligibility -- is it the right kind of event, and does it have a campaign or flow?
create_sessions as (
    select
        *,
        -- default klaviyo__event_attribution_filter limits attribution-eligible events to to email opens, email clicks, and sms opens
        -- https://help.klaviyo.com/hc/en-us/articles/115005248128

        -- events that come with flow/campaign attributions (and are eligible event types) will create new sessions.
        -- non-attributed events that come in afterward will be batched into the same attribution-session
        sum(case when touch_id is not null
        {% if var('klaviyo__eligible_attribution_events') != [] %}
            and lower(type) in {{ "('" ~ (var('klaviyo__eligible_attribution_events') | join("', '")) ~ "')" }}
        {% endif %}
            then 1 else 0 end) over (
                partition by person_id, source_relation order by occurred_at asc rows between unbounded preceding and current row) as touch_session 

    from events

),

-- "session start" refers to the event in a "touch session" that is already attributed with a campaign or flow by Klaviyo
-- a new event that is attributed with a campaign/flow will trigger a new session, so there will only be one already-attributed event per each session 
-- events that are missing attributions will borrow data from the event that triggered the session, if they are in the lookback window (see `attribute` CTE)
last_touches as (

    select 
        *,
        -- when did the touch session begin?
        min(occurred_at) over(partition by person_id, source_relation, touch_session) as session_start_at,

        -- get the kind of metric/event that triggered the attribution session, in order to decide 
        -- to use the sms or email lookback value. 
        first_value(type) over(
            partition by person_id, source_relation, touch_session order by occurred_at asc rows between unbounded preceding and current row) as session_event_type

    from create_sessions
),

attribute as (

    select 
        *,
        -- klaviyo uses different lookback windows for email and sms events
        -- default email lookback = 5 days (120 hours) -> https://help.klaviyo.com/hc/en-us/articles/115005248128#conversion-tracking1
        -- default sms lookback: 1 day (24 hours -> https://help.klaviyo.com/hc/en-us/articles/115005248128#sms-conversion-tracking7

        coalesce(touch_id, -- use pre-attributed flow/campaign if provided
            case 
            when {{ dbt.datediff('session_start_at', 'occurred_at', 'hour') }} <= (
                case 
                when lower(session_event_type) like '%sms%' then {{ var('klaviyo__sms_attribution_lookback') }}
                else {{ var('klaviyo__email_attribution_lookback') }} end
            ) -- if the events fall within the lookback window, attribute
            then first_value(touch_id) over (
                partition by person_id, source_relation, touch_session order by occurred_at asc rows between unbounded preceding and current row)
            else null end) as last_touch_id -- session qualified for attribution -> we will call this "last touch"

    from last_touches 
),

final as (

    select
        *,

        -- get whether the event is attributed to a flow or campaign
        coalesce(touch_type, first_value(touch_type) over(
            partition by person_id, source_relation, touch_session order by occurred_at asc rows between unbounded preceding and current row)) 

            as session_touch_type -- if the session events qualified for attribution, extract the type of touch they are attributed to

    from attribute 
)

select * from final