{% macro to_utc(col) %}cast({{ col }} as timestamp){% endmacro %}
