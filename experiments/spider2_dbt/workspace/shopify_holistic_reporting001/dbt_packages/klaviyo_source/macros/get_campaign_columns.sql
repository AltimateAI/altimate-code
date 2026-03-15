{% macro get_campaign_columns() %}

{% set columns = [
    {"name": "_fivetran_deleted", "datatype": "boolean"},
    {"name": "_fivetran_synced", "datatype": dbt.type_timestamp()},
    {"name": "campaign_type", "datatype": dbt.type_string()},
    {"name": "created", "datatype": dbt.type_timestamp()},
    {"name": "email_template_id", "datatype": dbt.type_string()},
    {"name": "from_email", "datatype": dbt.type_string()},
    {"name": "from_name", "datatype": dbt.type_string()},
    {"name": "id", "datatype": dbt.type_string()},
    {"name": "name", "datatype": dbt.type_string()},
    {"name": "send_time", "datatype": dbt.type_timestamp()},
    {"name": "sent_at", "datatype": dbt.type_timestamp()},
    {"name": "status", "datatype": dbt.type_string()},
    {"name": "status_id", "datatype": dbt.type_string()},
    {"name": "status_label", "datatype": dbt.type_string()},
    {"name": "subject", "datatype": dbt.type_string()},
    {"name": "updated", "datatype": dbt.type_timestamp()},
    {"name": "archived", "datatype": "boolean" },
    {"name": "scheduled", "datatype": dbt.type_timestamp()}
] %}

{{ return(columns) }}

{% endmacro %}
