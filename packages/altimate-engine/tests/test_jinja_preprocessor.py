"""Comprehensive tests for the Jinja/dbt template preprocessor."""

import pytest

from altimate_engine.sql.jinja_preprocessor import (
    contains_jinja,
    preprocess_jinja,
    JinjaPreprocessResult,
)


# ---------------------------------------------------------------------------
# contains_jinja detection
# ---------------------------------------------------------------------------


class TestContainsJinja:
    def test_plain_sql(self):
        assert contains_jinja("SELECT * FROM orders") is False

    def test_double_curly(self):
        assert contains_jinja("SELECT * FROM {{ ref('orders') }}") is True

    def test_block_tag(self):
        assert contains_jinja("{% if is_incremental() %}WHERE 1{% endif %}") is True

    def test_comment(self):
        assert contains_jinja("{# this is a comment #}") is True

    def test_empty_string(self):
        assert contains_jinja("") is False

    def test_curly_braces_in_json(self):
        """Single curly braces should not trigger detection."""
        assert contains_jinja("SELECT '{\"key\": \"value\"}'") is False

    def test_double_curly_in_string_literal(self):
        """We can't distinguish Jinja from literal {{ in strings, and that's OK."""
        assert contains_jinja("SELECT '{{ not_jinja }}'") is True


# ---------------------------------------------------------------------------
# ref() handling
# ---------------------------------------------------------------------------


class TestRefMacro:
    def test_simple_ref(self):
        sql = "SELECT * FROM {{ ref('stg_orders') }}"
        result = preprocess_jinja(sql)
        assert result.was_preprocessed is True
        assert "stg_orders" in result.preprocessed_sql
        assert "{{" not in result.preprocessed_sql
        assert result.refs_found == ["stg_orders"]

    def test_ref_with_double_quotes(self):
        sql = 'SELECT * FROM {{ ref("stg_orders") }}'
        result = preprocess_jinja(sql)
        assert "stg_orders" in result.preprocessed_sql
        assert result.refs_found == ["stg_orders"]

    def test_multiple_refs(self):
        sql = """
        SELECT o.id, c.name
        FROM {{ ref('orders') }} o
        JOIN {{ ref('customers') }} c ON o.customer_id = c.id
        """
        result = preprocess_jinja(sql)
        assert "orders" in result.preprocessed_sql
        assert "customers" in result.preprocessed_sql
        assert set(result.refs_found) == {"orders", "customers"}

    def test_ref_with_version(self):
        sql = "SELECT * FROM {{ ref('orders', v=2) }}"
        result = preprocess_jinja(sql)
        assert "orders" in result.preprocessed_sql
        assert result.refs_found == ["orders"]

    def test_ref_with_whitespace_variations(self):
        sql = "SELECT * FROM {{ref('orders')}}"
        result = preprocess_jinja(sql)
        assert "orders" in result.preprocessed_sql

    def test_ref_with_trimming(self):
        sql = "SELECT * FROM {{- ref('orders') -}}"
        result = preprocess_jinja(sql)
        assert "orders" in result.preprocessed_sql
        assert result.refs_found == ["orders"]


# ---------------------------------------------------------------------------
# source() handling
# ---------------------------------------------------------------------------


class TestSourceMacro:
    def test_simple_source(self):
        sql = "SELECT * FROM {{ source('raw', 'events') }}"
        result = preprocess_jinja(sql)
        assert "raw__events" in result.preprocessed_sql
        assert result.sources_found == ["raw.events"]

    def test_source_double_quotes(self):
        sql = 'SELECT * FROM {{ source("raw", "events") }}'
        result = preprocess_jinja(sql)
        assert "raw__events" in result.preprocessed_sql

    def test_multiple_sources(self):
        sql = """
        SELECT *
        FROM {{ source('raw', 'orders') }} o
        JOIN {{ source('raw', 'customers') }} c ON o.cid = c.id
        """
        result = preprocess_jinja(sql)
        assert "raw__orders" in result.preprocessed_sql
        assert "raw__customers" in result.preprocessed_sql
        assert set(result.sources_found) == {"raw.orders", "raw.customers"}

    def test_source_with_trimming(self):
        sql = "SELECT * FROM {{- source('raw', 'events') -}}"
        result = preprocess_jinja(sql)
        assert "raw__events" in result.preprocessed_sql


# ---------------------------------------------------------------------------
# var() handling
# ---------------------------------------------------------------------------


class TestVarMacro:
    def test_simple_var(self):
        sql = "WHERE date >= {{ var('start_date') }}"
        result = preprocess_jinja(sql)
        assert "'__var_start_date__'" in result.preprocessed_sql
        assert result.variables_found == ["start_date"]

    def test_var_with_default(self):
        sql = "WHERE date >= {{ var('start_date', '2024-01-01') }}"
        result = preprocess_jinja(sql)
        assert "'__var_start_date__'" in result.preprocessed_sql
        assert result.variables_found == ["start_date"]

    def test_multiple_vars(self):
        sql = """
        WHERE date BETWEEN {{ var('start_date') }} AND {{ var('end_date') }}
        AND status = {{ var('filter_status', 'active') }}
        """
        result = preprocess_jinja(sql)
        assert set(result.variables_found) == {"start_date", "end_date", "filter_status"}


# ---------------------------------------------------------------------------
# config() handling
# ---------------------------------------------------------------------------


class TestConfigMacro:
    def test_simple_config(self):
        sql = """
        {{ config(materialized='table') }}
        SELECT * FROM orders
        """
        result = preprocess_jinja(sql)
        assert "config" not in result.preprocessed_sql
        assert "SELECT * FROM orders" in result.preprocessed_sql
        assert "config()" in result.macros_removed

    def test_multiline_config(self):
        sql = """
        {{ config(
            materialized='incremental',
            unique_key='id',
            schema='staging'
        ) }}
        SELECT * FROM orders
        """
        result = preprocess_jinja(sql)
        assert "config" not in result.preprocessed_sql
        assert "SELECT * FROM orders" in result.preprocessed_sql

    def test_config_with_trimming(self):
        sql = """
        {{- config(materialized='table') -}}
        SELECT * FROM orders
        """
        result = preprocess_jinja(sql)
        assert "SELECT * FROM orders" in result.preprocessed_sql


# ---------------------------------------------------------------------------
# {{ this }} handling
# ---------------------------------------------------------------------------


class TestThisMacro:
    def test_simple_this(self):
        sql = "DELETE FROM {{ this }} WHERE updated_at < '2024-01-01'"
        result = preprocess_jinja(sql)
        assert "__this__" in result.preprocessed_sql
        assert "{{" not in result.preprocessed_sql

    def test_this_identifier(self):
        sql = "SELECT * FROM {{ this.identifier }}"
        result = preprocess_jinja(sql)
        assert "__this__" in result.preprocessed_sql

    def test_this_schema(self):
        sql = "SELECT '{{ this.schema }}' AS schema_name"
        result = preprocess_jinja(sql)
        assert "__this__" in result.preprocessed_sql


# ---------------------------------------------------------------------------
# Jinja comments
# ---------------------------------------------------------------------------


class TestComments:
    def test_single_line_comment(self):
        sql = "{# this is a comment #}\nSELECT * FROM orders"
        result = preprocess_jinja(sql)
        assert "comment" not in result.preprocessed_sql
        assert "SELECT * FROM orders" in result.preprocessed_sql

    def test_multiline_comment(self):
        sql = """{#
        This is a multiline
        comment block
        #}
        SELECT * FROM orders"""
        result = preprocess_jinja(sql)
        assert "multiline" not in result.preprocessed_sql
        assert "SELECT * FROM orders" in result.preprocessed_sql

    def test_inline_comment(self):
        sql = "SELECT * FROM orders {# inline comment #} WHERE id = 1"
        result = preprocess_jinja(sql)
        assert "inline" not in result.preprocessed_sql
        assert "WHERE id = 1" in result.preprocessed_sql


# ---------------------------------------------------------------------------
# {% if %} / {% elif %} / {% else %} / {% endif %}
# ---------------------------------------------------------------------------


class TestIfBlocks:
    def test_simple_if_endif(self):
        sql = """
        SELECT *
        FROM orders
        {% if is_incremental() %}
        WHERE updated_at > (SELECT MAX(updated_at) FROM {{ this }})
        {% endif %}
        """
        result = preprocess_jinja(sql)
        assert "SELECT *" in result.preprocessed_sql
        assert "FROM orders" in result.preprocessed_sql
        assert "WHERE updated_at" in result.preprocessed_sql
        assert "{% if" not in result.preprocessed_sql
        assert "{% endif" not in result.preprocessed_sql

    def test_if_else_endif(self):
        sql = """
        SELECT *
        FROM orders
        {% if target.name == 'prod' %}
        WHERE env = 'production'
        {% else %}
        WHERE env = 'development'
        {% endif %}
        """
        result = preprocess_jinja(sql)
        assert "WHERE env = 'production'" in result.preprocessed_sql
        assert "WHERE env = 'development'" in result.preprocessed_sql
        assert "{% if" not in result.preprocessed_sql
        assert "{% else" not in result.preprocessed_sql
        assert "{% endif" not in result.preprocessed_sql

    def test_if_elif_else_endif(self):
        sql = """
        {% if var('mode') == 'full' %}
        SELECT * FROM orders
        {% elif var('mode') == 'recent' %}
        SELECT * FROM orders WHERE date > CURRENT_DATE - 7
        {% else %}
        SELECT * FROM orders LIMIT 100
        {% endif %}
        """
        result = preprocess_jinja(sql)
        assert "SELECT * FROM orders" in result.preprocessed_sql
        assert "{% elif" not in result.preprocessed_sql

    def test_if_with_trimming(self):
        sql = """
        SELECT * FROM orders
        {%- if is_incremental() -%}
        WHERE updated_at > '2024-01-01'
        {%- endif -%}
        """
        result = preprocess_jinja(sql)
        assert "{% " not in result.preprocessed_sql
        assert "WHERE updated_at" in result.preprocessed_sql

    def test_if_with_modulo_operator(self):
        """Modulo operator (%) inside tags must not break regex matching."""
        sql = """
        SELECT
            id,
            {% if loop.index % 2 == 0 %}
            'even' AS parity
            {% else %}
            'odd' AS parity
            {% endif %}
        FROM orders
        """
        result = preprocess_jinja(sql)
        assert "{%" not in result.preprocessed_sql
        assert "'even' AS parity" in result.preprocessed_sql
        assert "'odd' AS parity" in result.preprocessed_sql


# ---------------------------------------------------------------------------
# {% for %} / {% endfor %}
# ---------------------------------------------------------------------------


class TestForBlocks:
    def test_simple_for(self):
        sql = """
        SELECT
        {% for col in ['id', 'name', 'email'] %}
            {{ col }},
        {% endfor %}
            created_at
        FROM users
        """
        result = preprocess_jinja(sql)
        assert "created_at" in result.preprocessed_sql
        assert "{% for" not in result.preprocessed_sql
        assert "{% endfor" not in result.preprocessed_sql


# ---------------------------------------------------------------------------
# {% set %} handling
# ---------------------------------------------------------------------------


class TestSetBlocks:
    def test_simple_set(self):
        sql = """
        {% set payment_methods = ['credit_card', 'bank_transfer', 'gift_card'] %}
        SELECT * FROM orders
        """
        result = preprocess_jinja(sql)
        assert "SELECT * FROM orders" in result.preprocessed_sql
        assert "{% set" not in result.preprocessed_sql

    def test_set_block_form(self):
        sql = """
        {% set query %}
        SELECT * FROM {{ ref('orders') }}
        {% endset %}
        SELECT * FROM staging
        """
        result = preprocess_jinja(sql)
        assert "{% set" not in result.preprocessed_sql
        assert "{% endset" not in result.preprocessed_sql


# ---------------------------------------------------------------------------
# {% macro %} / {% endmacro %}
# ---------------------------------------------------------------------------


class TestMacroBlocks:
    def test_macro_block(self):
        sql = """
        {% macro generate_schema_name(custom_schema_name, node) -%}
            {{ custom_schema_name | trim }}
        {%- endmacro %}

        SELECT * FROM orders
        """
        result = preprocess_jinja(sql)
        assert "SELECT * FROM orders" in result.preprocessed_sql
        assert "{% macro" not in result.preprocessed_sql
        assert "{% endmacro" not in result.preprocessed_sql
        assert "macro block(s)" in result.macros_removed


# ---------------------------------------------------------------------------
# adapter.dispatch, return, log, exceptions
# ---------------------------------------------------------------------------


class TestUtilityMacros:
    def test_adapter_dispatch(self):
        sql = """
        {{ adapter.dispatch('my_macro')() }}
        SELECT * FROM orders
        """
        result = preprocess_jinja(sql)
        assert "adapter" not in result.preprocessed_sql
        assert "__jinja_expr__" in result.preprocessed_sql
        assert "SELECT * FROM orders" in result.preprocessed_sql

    def test_return(self):
        sql = "{{ return([]) }}"
        result = preprocess_jinja(sql)
        assert "return" not in result.preprocessed_sql
        assert "__jinja_expr__" in result.preprocessed_sql

    def test_log(self):
        sql = """
        {{ log('Processing started', info=True) }}
        SELECT * FROM orders
        """
        result = preprocess_jinja(sql)
        assert "log(" not in result.preprocessed_sql
        assert "__jinja_expr__" in result.preprocessed_sql


# ---------------------------------------------------------------------------
# No Jinja (passthrough)
# ---------------------------------------------------------------------------


class TestNoJinja:
    def test_plain_sql(self):
        sql = "SELECT * FROM orders WHERE id = 1"
        result = preprocess_jinja(sql)
        assert result.was_preprocessed is False
        assert result.preprocessed_sql == sql
        assert result.refs_found == []
        assert result.sources_found == []
        assert result.variables_found == []

    def test_empty_sql(self):
        sql = ""
        result = preprocess_jinja(sql)
        assert result.was_preprocessed is False
        assert result.preprocessed_sql == ""


# ---------------------------------------------------------------------------
# Complex real-world dbt models
# ---------------------------------------------------------------------------


class TestRealWorldModels:
    def test_typical_incremental_model(self):
        sql = """
        {{ config(
            materialized='incremental',
            unique_key='order_id',
            schema='mart'
        ) }}

        WITH source AS (
            SELECT *
            FROM {{ ref('stg_orders') }}
            {% if is_incremental() %}
            WHERE updated_at > (SELECT MAX(updated_at) FROM {{ this }})
            {% endif %}
        ),

        customers AS (
            SELECT *
            FROM {{ ref('stg_customers') }}
        )

        SELECT
            s.order_id,
            s.customer_id,
            c.customer_name,
            s.order_date,
            s.amount,
            {{ var('tax_rate', 0.1) }} AS tax_rate,
            s.amount * {{ var('tax_rate', 0.1) }} AS tax_amount
        FROM source s
        LEFT JOIN customers c ON s.customer_id = c.customer_id
        """
        result = preprocess_jinja(sql)
        assert result.was_preprocessed is True
        assert "SELECT" in result.preprocessed_sql
        assert "FROM stg_orders" in result.preprocessed_sql or "stg_orders" in result.preprocessed_sql
        assert "stg_customers" in result.preprocessed_sql
        assert "__this__" in result.preprocessed_sql
        assert "config" not in result.preprocessed_sql.split("SELECT")[0]  # config removed before first SELECT
        assert "{{" not in result.preprocessed_sql
        assert "{%" not in result.preprocessed_sql
        assert set(result.refs_found) == {"stg_orders", "stg_customers"}
        assert "tax_rate" in result.variables_found

    def test_model_with_sources(self):
        sql = """
        {{ config(materialized='view') }}

        {# Pull raw data from external sources #}

        SELECT
            id,
            name,
            email,
            created_at
        FROM {{ source('stripe', 'payments') }}
        WHERE status = 'completed'
        """
        result = preprocess_jinja(sql)
        assert "stripe__payments" in result.preprocessed_sql
        assert result.sources_found == ["stripe.payments"]
        assert "{#" not in result.preprocessed_sql

    def test_model_with_for_loop_columns(self):
        sql = """
        {{ config(materialized='table') }}

        SELECT
            order_id,
            {% for status in ['placed', 'shipped', 'completed', 'returned'] %}
            SUM(CASE WHEN status = '{{ status }}' THEN 1 ELSE 0 END) AS {{ status }}_count
            {% if not loop.last %},{% endif %}
            {% endfor %}
        FROM {{ ref('orders') }}
        GROUP BY 1
        """
        result = preprocess_jinja(sql)
        assert "order_id" in result.preprocessed_sql
        assert "{{" not in result.preprocessed_sql
        assert "{%" not in result.preprocessed_sql
        assert result.refs_found == ["orders"]

    def test_snapshot_model(self):
        sql = """
        {% snapshot orders_snapshot %}

        {{ config(
            target_schema='snapshots',
            unique_key='id',
            strategy='timestamp',
            updated_at='updated_at'
        ) }}

        SELECT * FROM {{ source('jaffle_shop', 'orders') }}

        {% endsnapshot %}
        """
        result = preprocess_jinja(sql)
        assert "jaffle_shop__orders" in result.preprocessed_sql
        assert result.sources_found == ["jaffle_shop.orders"]

    def test_sql_preserves_valid_structure(self):
        """After preprocessing, the SQL should be parseable (no syntax errors from stubs)."""
        sql = """
        SELECT
            o.id,
            o.amount,
            c.name
        FROM {{ ref('orders') }} o
        JOIN {{ ref('customers') }} c ON o.customer_id = c.id
        WHERE o.status = {{ var('status', 'active') }}
        """
        result = preprocess_jinja(sql)
        # The result should be valid-ish SQL
        assert "SELECT" in result.preprocessed_sql
        assert "FROM orders o" in result.preprocessed_sql
        assert "JOIN customers c" in result.preprocessed_sql
        assert "'__var_status__'" in result.preprocessed_sql


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_nested_jinja(self):
        """Nested Jinja expressions like {{ ref(var('model_name')) }}."""
        sql = "SELECT * FROM {{ ref(var('model_name')) }}"
        result = preprocess_jinja(sql)
        assert result.was_preprocessed is True
        assert "{{" not in result.preprocessed_sql

    def test_consecutive_templates(self):
        sql = "{{ config(materialized='table') }}{{ config(schema='staging') }}"
        result = preprocess_jinja(sql)
        assert "{{" not in result.preprocessed_sql

    def test_whitespace_only_after_removal(self):
        sql = "{{ config(materialized='table') }}"
        result = preprocess_jinja(sql)
        assert "{{" not in result.preprocessed_sql

    def test_mixed_quotes(self):
        sql = """SELECT * FROM {{ ref("model_a") }} JOIN {{ ref('model_b') }}"""
        result = preprocess_jinja(sql)
        assert "model_a" in result.preprocessed_sql
        assert "model_b" in result.preprocessed_sql
        assert set(result.refs_found) == {"model_a", "model_b"}

    def test_remaining_unknown_expression_gets_warning(self):
        sql = "SELECT {{ custom_macro(arg1, arg2) }} FROM t"
        result = preprocess_jinja(sql)
        assert result.was_preprocessed is True
        # Unknown expressions should produce a warning
        assert len(result.warnings) > 0 or "__jinja_expr__" in result.preprocessed_sql

    def test_result_to_dict(self):
        sql = "SELECT * FROM {{ ref('orders') }}"
        result = preprocess_jinja(sql)
        d = result.to_dict()
        assert isinstance(d, dict)
        assert d["was_preprocessed"] is True
        assert d["refs_found"] == ["orders"]
        assert "preprocessed_sql" in d
        assert "original_sql" in d

    def test_no_extra_blank_lines(self):
        """Preprocessing shouldn't create excessive blank lines."""
        sql = """

        {{ config(materialized='table') }}


        {% set x = 'hello' %}


        SELECT * FROM orders
        """
        result = preprocess_jinja(sql)
        # Check no triple+ newlines
        assert "\n\n\n" not in result.preprocessed_sql


# ---------------------------------------------------------------------------
# Server integration: dispatch sql.preprocess_jinja
# ---------------------------------------------------------------------------


class TestServerDispatch:
    def test_preprocess_jinja_dispatch(self):
        from altimate_engine.server import dispatch
        from altimate_engine.models import JsonRpcRequest

        request = JsonRpcRequest(
            method="sql.preprocess_jinja",
            params={"sql": "SELECT * FROM {{ ref('orders') }}"},
            id=1,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is True
        assert response.result["was_preprocessed"] is True
        assert "orders" in response.result["preprocessed_sql"]
        assert response.result["refs_found"] == ["orders"]

    def test_preprocess_jinja_no_jinja(self):
        from altimate_engine.server import dispatch
        from altimate_engine.models import JsonRpcRequest

        request = JsonRpcRequest(
            method="sql.preprocess_jinja",
            params={"sql": "SELECT 1"},
            id=2,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["was_preprocessed"] is False

    def test_sql_analyze_with_jinja(self):
        """sql.analyze should auto-preprocess Jinja and note it in confidence_factors."""
        from altimate_engine.server import dispatch
        from altimate_engine.models import JsonRpcRequest

        request = JsonRpcRequest(
            method="sql.analyze",
            params={
                "sql": "SELECT * FROM {{ ref('orders') }}",
                "dialect": "snowflake",
            },
            id=3,
        )
        response = dispatch(request)
        assert response.error is None
        # The Jinja preprocessing note should appear regardless of altimate_core
        factors = response.result.get("confidence_factors", [])
        jinja_noted = any("Jinja" in f for f in factors)
        assert jinja_noted, f"Expected Jinja note in confidence_factors: {factors}"

    def test_sql_format_with_jinja(self):
        """sql.format should auto-preprocess Jinja before formatting."""
        from altimate_engine.server import dispatch
        from altimate_engine.models import JsonRpcRequest

        request = JsonRpcRequest(
            method="sql.format",
            params={
                "sql": "select * from {{ ref('orders') }} where id=1",
                "dialect": "snowflake",
            },
            id=4,
        )
        response = dispatch(request)
        assert response.error is None
        # If altimate_core is installed, formatting succeeds
        if response.result.get("success"):
            assert response.result["formatted_sql"] is not None
        else:
            # Without altimate_core, we just verify the response shape
            assert "formatted_sql" in response.result

    def test_sql_translate_with_jinja(self):
        """sql.translate should auto-preprocess Jinja before translation."""
        from altimate_engine.server import dispatch
        from altimate_engine.models import JsonRpcRequest

        request = JsonRpcRequest(
            method="sql.translate",
            params={
                "sql": "SELECT DATEADD(day, 7, current_date()) FROM {{ ref('orders') }}",
                "source_dialect": "snowflake",
                "target_dialect": "bigquery",
            },
            id=5,
        )
        response = dispatch(request)
        assert response.error is None
        if response.result.get("success"):
            # Should have Jinja warning when altimate_core is available
            warnings = response.result.get("warnings", [])
            jinja_warned = any("Jinja" in w for w in warnings)
            assert jinja_warned, f"Expected Jinja warning: {warnings}"
        else:
            # Without altimate_core, verify the response shape
            assert "error" in response.result

    def test_sql_optimize_with_jinja(self):
        """sql.optimize should auto-preprocess Jinja before optimization."""
        from altimate_engine.server import dispatch
        from altimate_engine.models import JsonRpcRequest

        request = JsonRpcRequest(
            method="sql.optimize",
            params={
                "sql": "SELECT * FROM {{ ref('orders') }} WHERE 1=1",
                "dialect": "snowflake",
            },
            id=6,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is True
