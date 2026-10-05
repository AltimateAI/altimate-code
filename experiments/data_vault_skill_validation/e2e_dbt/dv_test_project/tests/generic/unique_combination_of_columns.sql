{% test unique_combination_of_columns(model, combination_of_columns) %}
    SELECT {{ combination_of_columns | join(", ") }}, COUNT(*) AS c
    FROM {{ model }}
    GROUP BY {{ combination_of_columns | join(", ") }}
    HAVING COUNT(*) > 1
{% endtest %}
