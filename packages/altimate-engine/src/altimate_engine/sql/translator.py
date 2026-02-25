"""Cross-dialect SQL translation using sqlglot transpile."""

from __future__ import annotations

from typing import Any

import sqlglot
from sqlglot.errors import ErrorLevel


# Known lossy translation pairs where data type semantics differ.
# Each entry maps (source, target) to a list of warning messages.
LOSSY_TRANSLATION_WARNINGS: dict[tuple[str, str], list[str]] = {
    ("snowflake", "postgres"): [
        "Snowflake VARIANT/OBJECT/ARRAY types map to JSON/JSONB in PostgreSQL — verify JSON access patterns.",
        "Snowflake GEOGRAPHY/GEOMETRY types require PostGIS extension in PostgreSQL.",
    ],
    ("snowflake", "mysql"): [
        "Snowflake VARIANT/OBJECT/ARRAY types have no direct MySQL equivalent — mapped to JSON.",
        "Snowflake TIMESTAMP_TZ/TIMESTAMP_LTZ timezone semantics differ in MySQL.",
    ],
    ("bigquery", "snowflake"): [
        "BigQuery STRUCT types map to Snowflake OBJECT — nested field access syntax differs.",
        "BigQuery partition filter syntax (_PARTITIONTIME) has no direct Snowflake equivalent.",
    ],
    ("bigquery", "postgres"): [
        "BigQuery STRUCT types require restructuring for PostgreSQL.",
        "BigQuery backtick-quoted project.dataset.table references need manual adjustment.",
    ],
    ("tsql", "postgres"): [
        "T-SQL TOP N syntax is translated to LIMIT — verify ORDER BY is present.",
        "T-SQL IDENTITY columns map to SERIAL/GENERATED in PostgreSQL.",
    ],
    ("tsql", "snowflake"): [
        "T-SQL stored procedure calls may not translate — Snowflake uses JavaScript UDFs.",
    ],
    ("mysql", "postgres"): [
        "MySQL UNSIGNED integer types have no PostgreSQL equivalent — check constraints may be needed.",
        "MySQL AUTO_INCREMENT maps to SERIAL/GENERATED ALWAYS in PostgreSQL.",
    ],
    ("postgres", "mysql"): [
        "PostgreSQL JSONB operators (->>, #>) need conversion to MySQL JSON_EXTRACT syntax.",
        "PostgreSQL array types have no direct MySQL equivalent.",
    ],
    ("redshift", "snowflake"): [
        "Redshift DISTKEY/SORTKEY clauses are removed — Snowflake uses automatic clustering.",
    ],
    ("redshift", "postgres"): [
        "Redshift-specific functions (GETDATE, DATEADD) are translated to PostgreSQL equivalents.",
        "Redshift DISTKEY/SORTKEY/ENCODE clauses are removed.",
    ],
}


def translate_sql(sql: str, source_dialect: str, target_dialect: str) -> dict[str, Any]:
    """Translate SQL from one dialect to another.

    Args:
        sql: The SQL to translate
        source_dialect: Source dialect (e.g., 'snowflake', 'bigquery', 'postgres',
            'mysql', 'tsql', 'hive', 'spark', 'databricks', 'redshift', 'duckdb')
        target_dialect: Target dialect

    Returns:
        Dictionary with keys:
            success: True if translation succeeded
            translated_sql: The translated SQL string (or None on failure)
            source_dialect: Echo of the source dialect
            target_dialect: Echo of the target dialect
            warnings: List of translation warnings
            error: Error message if translation failed, else None
    """
    source = source_dialect.lower().strip()
    target = target_dialect.lower().strip()

    if source == target:
        return {
            "success": True,
            "translated_sql": sql,
            "source_dialect": source,
            "target_dialect": target,
            "warnings": ["Source and target dialects are the same — no translation needed."],
            "error": None,
        }

    try:
        translated_statements = sqlglot.transpile(
            sql,
            read=source,
            write=target,
            pretty=True,
            error_level=ErrorLevel.WARN,
        )
    except sqlglot.errors.ParseError as e:
        return {
            "success": False,
            "translated_sql": None,
            "source_dialect": source,
            "target_dialect": target,
            "warnings": [],
            "error": f"Failed to parse SQL as {source} dialect: {e}",
        }
    except sqlglot.errors.UnsupportedError as e:
        return {
            "success": False,
            "translated_sql": None,
            "source_dialect": source,
            "target_dialect": target,
            "warnings": [],
            "error": f"Unsupported translation from {source} to {target}: {e}",
        }
    except Exception as e:
        return {
            "success": False,
            "translated_sql": None,
            "source_dialect": source,
            "target_dialect": target,
            "warnings": [],
            "error": f"Translation failed: {e}",
        }

    translated_sql = ";\n".join(translated_statements)

    # Collect applicable warnings
    warnings: list[str] = []
    pair_warnings = LOSSY_TRANSLATION_WARNINGS.get((source, target), [])
    warnings.extend(pair_warnings)

    return {
        "success": True,
        "translated_sql": translated_sql,
        "source_dialect": source,
        "target_dialect": target,
        "warnings": warnings,
        "error": None,
    }
