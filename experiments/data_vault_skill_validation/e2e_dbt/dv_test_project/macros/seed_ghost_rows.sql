{#
    Seed the ghost row for every hub. Idempotent — INSERT WHERE NOT EXISTS.
    Call via: dbt run-operation seed_ghost_rows
#}

{% macro seed_ghost_rows() %}
    {% set hubs = [
        ('hub_customer',        'customer_hk',        'customer_bk'),
        ('hub_order',           'order_hk',           'order_bk'),
        ('hub_account_manager', 'account_manager_hk', 'account_manager_bk'),
    ] %}

    {% for (hub, hk_col, bk_col) in hubs %}
        {% set sql %}
            INSERT INTO {{ ref(hub) }} ({{ hk_col }}, {{ bk_col }}, load_dts, record_source)
            SELECT
                {{ dv_hash_function() }}('^^'),
                '^^',
                CAST('1900-01-01' AS TIMESTAMP),
                'SYSTEM.ZERO_KEY'
            WHERE NOT EXISTS (
                SELECT 1 FROM {{ ref(hub) }}
                WHERE {{ hk_col }} = {{ dv_hash_function() }}('^^')
            )
        {% endset %}
        {% do run_query(sql) %}
        {% do log("Seeded ghost row for " ~ hub, info=True) %}
    {% endfor %}
{% endmacro %}
