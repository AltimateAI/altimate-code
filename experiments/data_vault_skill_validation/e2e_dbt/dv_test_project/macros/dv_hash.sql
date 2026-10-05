{# Data Vault hash macros — mirror the skill's hashing-and-keys.md #}

{% macro dv_hash_function() %}
    {%- if target.type == 'duckdb' -%}
        md5
    {%- elif target.type in ('snowflake', 'bigquery') -%}
        md5_binary
    {%- else -%}
        md5
    {%- endif -%}
{% endmacro %}


{% macro dv_hash_bk(columns) %}
    {#- Business key hash: TRIM → UPPER → COALESCE(sentinel) → concatenate → hash -#}
    {%- set parts = [] -%}
    {%- for col in columns -%}
        {%- do parts.append(
            "COALESCE(NULLIF(UPPER(TRIM(CAST(" ~ col ~ " AS VARCHAR))), ''), '^^')"
        ) -%}
    {%- endfor -%}
    {{ dv_hash_function() }}(
        {{ parts | join(" || '||' || ") }}
    )
{% endmacro %}


{% macro dv_hashdiff(columns) %}
    {#- Descriptive-column hash: SORTED, normalized, delimited, hashed -#}
    {%- set sorted_cols = columns | sort -%}
    {%- set parts = [] -%}
    {%- for col in sorted_cols -%}
        {%- do parts.append(
            "COALESCE(NULLIF(UPPER(TRIM(CAST(" ~ col ~ " AS VARCHAR))), ''), '^^')"
        ) -%}
    {%- endfor -%}
    {{ dv_hash_function() }}(
        {{ parts | join(" || '||' || ") }}
    )
{% endmacro %}
