{% macro remove_string_from_numeric(column_name) -%}

{{ adapter.dispatch('remove_string_from_numeric', 'klaviyo_source') (column_name) }}

{%- endmacro %}

{% macro default__remove_string_from_numeric(column_name) %}
    
    cast(regexp_replace(cast({{ column_name }} as {{ dbt.type_string() }}), '[^0-9.]*', '') as {{ dbt.type_numeric() }})

{% endmacro %}

{% macro bigquery__remove_string_from_numeric(column_name) %}

    cast(regexp_replace(cast({{ column_name }} as {{ dbt.type_string() }}), r'[^0-9.]*', '') as {{ dbt.type_numeric() }})

{% endmacro %}

{% macro postgres__remove_string_from_numeric(column_name) %}

    cast(regexp_replace(cast({{ column_name }} as {{ dbt.type_string() }}), '[^0-9.]*', '', 'g') as {{ dbt.type_numeric() }})

{% endmacro %}

{% macro redshift__remove_string_from_numeric(column_name) %}
    
    cast(regexp_replace(cast({{ column_name }} as {{ dbt.type_string() }}), '[^0-9.]*', '') as {{ dbt.type_numeric() }})

{% endmacro %}

