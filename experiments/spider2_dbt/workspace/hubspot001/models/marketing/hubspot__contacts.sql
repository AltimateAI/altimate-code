{{ config(enabled=fivetran_utils.enabled_vars(['hubspot_marketing_enabled','hubspot_contact_enabled'])) }}

with contacts as (

    select *
    from {{ ref('int_hubspot__contact_merge_adjust') }}

{% if fivetran_utils.enabled_vars(['hubspot_email_event_enabled','hubspot_email_event_sent_enabled']) %}

), email_sends as (

    select *
    from {{ ref('hubspot__email_sends') }}

), email_metrics as (

    {% set email_metrics = adjust_email_metrics('hubspot__email_sends', 'email_metrics') %}
    select
        contact_id,
        {% for metric in email_metrics %}
        sum({{ metric }}) as total_{{ metric }},
        count(distinct case when {{ metric }} > 0 then email_send_id end) as total_unique_{{ metric }}
        {% if not loop.last %},{% endif %}
        {% endfor %}
    from email_sends
    where contact_id is not null
    group by 1

{% endif %}

{% if fivetran_utils.enabled_vars(['hubspot_sales_enabled','hubspot_engagement_enabled','hubspot_engagement_contact_enabled']) %}

), engagement_metrics as (

    select *
    from {{ ref('int_hubspot__engagement_metrics__by_contact') }}

{% endif %}

), joined as (

    select
        contacts.*

        {% if fivetran_utils.enabled_vars(['hubspot_email_event_enabled','hubspot_email_event_sent_enabled']) %}
        {% set email_metrics = adjust_email_metrics('hubspot__email_sends', 'email_metrics') %}
        {% for metric in email_metrics %}
        , coalesce(email_metrics.total_{{ metric }}, 0) as total_{{ metric }}
        , coalesce(email_metrics.total_unique_{{ metric }}, 0) as total_unique_{{ metric }}
        {% endfor %}
        {% endif %}

        {% if fivetran_utils.enabled_vars(['hubspot_sales_enabled','hubspot_engagement_enabled','hubspot_engagement_contact_enabled']) %}
        {% for metric in engagement_metrics() %}
        , coalesce(engagement_metrics.{{ metric }}, 0) as {{ metric }}
        {% endfor %}
        {% endif %}

    from contacts

    {% if fivetran_utils.enabled_vars(['hubspot_email_event_enabled','hubspot_email_event_sent_enabled']) %}
    left join email_metrics
        using (contact_id)
    {% endif %}

    {% if fivetran_utils.enabled_vars(['hubspot_sales_enabled','hubspot_engagement_enabled','hubspot_engagement_contact_enabled']) %}
    left join engagement_metrics
        using (contact_id)
    {% endif %}

)

select *
from joined
