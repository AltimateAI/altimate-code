{% macro cents_to_dollars(col) %}round({{ col }} / 100.0, 2){% endmacro %}
