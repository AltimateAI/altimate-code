"""Pre-compute DuckDB schema information for benchmark tasks.

Queries the DuckDB database in a workspace to extract a compact
table listing (name + columns + row count). Kept concise to avoid
overwhelming the agent prompt.
"""

from __future__ import annotations

from pathlib import Path


def introspect_duckdb_schema(workspace: Path, max_tables: int = 30) -> str:
    """Query DuckDB database files in workspace and return a compact schema summary.

    Produces a ~2-4KB summary listing tables with their columns (name + type)
    and row counts. No sample data — keeps the prompt focused.

    Args:
        workspace: Path to the dbt project workspace directory.
        max_tables: Maximum number of tables to include.

    Returns:
        A formatted string with schema information, or empty string if no DB found.
    """
    try:
        import duckdb
    except ImportError:
        return ""

    # Find DuckDB files
    db_files = list(workspace.glob("*.duckdb")) + list(workspace.glob("*.db"))
    if not db_files:
        db_files = [
            f for f in workspace.rglob("*.duckdb")
            if "target" not in str(f) and ".dbt" not in str(f)
        ]
    if not db_files:
        return ""

    db_path = db_files[0]

    try:
        conn = duckdb.connect(str(db_path), read_only=True)
    except Exception:
        return ""

    try:
        tables = conn.execute(
            "SELECT table_schema, table_name FROM information_schema.tables "
            "WHERE table_schema NOT IN ('information_schema', 'pg_catalog') "
            "ORDER BY table_schema, table_name"
        ).fetchall()

        if not tables:
            conn.close()
            return ""

        lines = [f"## Source Database: `{db_path.name}` ({len(tables)} tables)\n"]

        for schema, table in tables[:max_tables]:
            full_name = f"{schema}.{table}" if schema != "main" else table

            # Get columns (name + type only)
            cols = conn.execute(
                "SELECT column_name, data_type FROM information_schema.columns "
                f"WHERE table_schema = '{schema}' AND table_name = '{table}' "
                "ORDER BY ordinal_position"
            ).fetchall()

            # Get row count
            try:
                row_count = conn.execute(
                    f'SELECT COUNT(*) FROM "{schema}"."{table}"'
                ).fetchone()[0]
            except Exception:
                row_count = "?"

            col_summary = ", ".join(f"{c[0]} ({c[1]})" for c in cols)
            lines.append(f"- **{full_name}** ({row_count} rows): {col_summary}")

        result = "\n".join(lines)

        # Hard cap at 5000 chars to avoid overwhelming the prompt
        if len(result) > 5000:
            # Truncate and add note
            result = result[:4900] + "\n\n... (truncated — query the database for full schema)"

        return result

    except Exception:
        return ""
    finally:
        conn.close()
