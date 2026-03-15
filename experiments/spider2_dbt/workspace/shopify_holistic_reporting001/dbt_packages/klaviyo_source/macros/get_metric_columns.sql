{% macro get_metric_columns() %}

{% set columns = [
    {"name": "_fivetran_deleted", "datatype": "boolean"},
    {"name": "_fivetran_synced", "datatype": dbt.type_timestamp()},
    {"name": "created", "datatype": dbt.type_timestamp()},
    {"name": "id", "datatype": dbt.type_string()},
    {"name": "integration_id", "datatype": dbt.type_string()},
    {"name": "integration_category", "datatype": dbt.type_string()},
    {"name": "integration_name", "datatype": dbt.type_string()},
    {"name": "name", "datatype": dbt.type_string()},
    {"name": "updated", "datatype": dbt.type_timestamp()}
] %}

{{ return(columns) }}

{% endmacro %}
