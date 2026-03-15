{{ config(enabled=fivetran_utils.enabled_vars(['hubspot_marketing_enabled','hubspot_email_event_enabled'])) }}

with campaigns as (

    select *
    from {{ ref('stg_hubspot__email_campaign') }}

), email_sends as (

    select *
    from {{ ref('hubspot__email_sends') }}

), email_metrics as (

    {% set email_metrics = adjust_email_metrics('hubspot__email_sends', 'email_metrics') %}
    select
        email_campaign_id,
        {% for metric in email_metrics %}
        sum({{ metric }}) as total_{{ metric }},
        count(distinct case when {{ metric }} > 0 then email_send_id end) as total_unique_{{ metric }}
        {% if not loop.last %},{% endif %}
        {% endfor %}
    from email_sends
    where email_campaign_id is not null
    group by 1

), joined as (

    select
        campaigns.*,

        {% set email_metrics = adjust_email_metrics('hubspot__email_sends', 'email_metrics') %}
        {% for metric in email_metrics %}
        coalesce(email_metrics.total_{{ metric }}, 0) as total_{{ metric }},
        coalesce(email_metrics.total_unique_{{ metric }}, 0) as total_unique_{{ metric }}
        {% if not loop.last %},{% endif %}
        {% endfor %}

    from campaigns
    left join email_metrics
        on cast(campaigns.email_campaign_id as {{ dbt.type_string() }}) = cast(email_metrics.email_campaign_id as {{ dbt.type_string() }})

)

select *
from joined
