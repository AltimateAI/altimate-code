{% test assert_no_consecutive_matching_hashdiffs(model, parent_key) %}
    WITH ordered AS (
        SELECT
            {{ parent_key }} AS parent_hk,
            load_dts,
            hashdiff,
            LAG(hashdiff) OVER (
                PARTITION BY {{ parent_key }} ORDER BY load_dts
            ) AS prev_hashdiff
        FROM {{ model }}
    )
    SELECT * FROM ordered
    WHERE prev_hashdiff IS NOT NULL
      AND prev_hashdiff = hashdiff
{% endtest %}
