{% macro get_flow_columns() %}

{% set columns = [
    {"name": "_fivetran_deleted", "datatype": "boolean"},
    {"name": "_fivetran_synced", "datatype": dbt.type_timestamp()},
    {"name": "created", "datatype": dbt.type_timestamp()},
    {"name": "id", "datatype": dbt.type_string()},
    {"name": "name", "datatype": dbt.type_string()},
    {"name": "status", "datatype": dbt.type_string()},
    {"name": "updated", "datatype": dbt.type_timestamp()},
    {"name": "archived", "datatype": "boolean" },
    {"name": "trigger_type", "datatype": dbt.type_string()},
] %}

{{ return(columns) }}

{% endmacro %}
