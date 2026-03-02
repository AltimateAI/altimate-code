"""Run SQL against local DuckDB — validate syntax, types, and logic locally."""

from __future__ import annotations

from typing import Any


def test_sql_local(
    sql: str,
    target_path: str = ":memory:",
    target_dialect: str | None = None,
) -> dict[str, Any]:
    """Execute SQL against a local DuckDB database for validation.

    If target_dialect differs from DuckDB, auto-transpiles first.

    Args:
        sql: The SQL to test.
        target_path: Path to DuckDB file (should be one created by schema_sync).
        target_dialect: If not 'duckdb', transpile first. E.g. 'snowflake', 'bigquery'.

    Returns:
        Dict with success, error, row_count, columns, etc.
    """
    try:
        from altimate_engine.connectors.duckdb import DuckDBConnector
    except ImportError:
        return {
            "success": False,
            "error": "duckdb not installed. Install with: pip install duckdb",
        }

    # Auto-transpile if target dialect differs from DuckDB
    test_sql = sql
    transpiled = False
    transpile_warnings: list[str] = []

    if target_dialect and target_dialect.lower() not in ("duckdb", "duck"):
        try:
            from altimate_engine.sql.guard import guard_transpile

            result = guard_transpile(sql, target_dialect, "duckdb")
            translated = result.get("sql", result.get("translated_sql"))
            if result.get("success") and translated:
                test_sql = translated
                transpiled = True
                transpile_warnings = result.get("warnings", [])
        except Exception as e:
            transpile_warnings.append(f"Transpilation failed, testing original SQL: {e}")

    local = DuckDBConnector(path=target_path)

    try:
        local.connect()
        rows = local.execute(test_sql)

        return {
            "success": True,
            "row_count": len(rows),
            "columns": list(rows[0].keys()) if rows else [],
            "sample_rows": rows[:5],
            "transpiled": transpiled,
            "transpile_warnings": transpile_warnings if transpile_warnings else None,
        }
    except Exception as e:
        error_msg = str(e)
        return {
            "success": False,
            "error": error_msg,
            "transpiled": transpiled,
            "transpile_warnings": transpile_warnings if transpile_warnings else None,
        }
    finally:
        local.close()
