"""SQL formatting / beautification using sqlglot."""

from __future__ import annotations

import sqlglot


def format_sql(sql: str, dialect: str = "snowflake", indent: int = 2) -> dict:
    """Format SQL using sqlglot's pretty-print.

    Args:
        sql: Raw SQL string
        dialect: SQL dialect for parsing/generation
        indent: Indentation width (spaces)

    Returns:
        Dict with formatted_sql, success, and error fields.
    """
    try:
        statements = sqlglot.transpile(
            sql,
            read=dialect,
            write=dialect,
            pretty=True,
            indent=indent,
        )
        formatted = ";\n\n".join(statements)
        # Add trailing semicolon if the original had one or there are multiple statements
        if sql.rstrip().endswith(";") or len(statements) > 1:
            formatted += ";"

        return {
            "success": True,
            "formatted_sql": formatted,
            "statement_count": len(statements),
            "error": None,
        }
    except sqlglot.errors.ErrorLevel:
        # Fallback: try without dialect-specific parsing
        try:
            statements = sqlglot.transpile(sql, pretty=True, indent=indent)
            formatted = ";\n\n".join(statements)
            if sql.rstrip().endswith(";"):
                formatted += ";"
            return {
                "success": True,
                "formatted_sql": formatted,
                "statement_count": len(statements),
                "error": None,
            }
        except Exception as e:
            return {
                "success": False,
                "formatted_sql": None,
                "statement_count": 0,
                "error": str(e),
            }
    except Exception as e:
        return {
            "success": False,
            "formatted_sql": None,
            "statement_count": 0,
            "error": str(e),
        }
