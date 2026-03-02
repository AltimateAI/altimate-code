"""SQL execution against warehouse connections."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry
from altimate_engine.models import SqlExecuteParams, SqlExecuteResult


def execute_sql(params: SqlExecuteParams) -> SqlExecuteResult:
    """Execute SQL against a warehouse connection.

    Uses ConnectionRegistry to resolve named connections.
    Falls back to treating warehouse as a raw postgres connection string
    for backwards compatibility.
    """
    if not params.warehouse:
        return SqlExecuteResult(
            columns=["error"],
            rows=[["No warehouse specified. Use warehouse_list to see available connections."]],
            row_count=1,
            truncated=False,
        )

    # Try ConnectionRegistry first
    try:
        connector = ConnectionRegistry.get(params.warehouse)
    except ValueError:
        # Fallback: treat as raw postgres connection string for backwards compat
        if params.warehouse.startswith("postgres"):
            return _execute_postgres_raw(params)
        return SqlExecuteResult(
            columns=["error"],
            rows=[[f"Connection '{params.warehouse}' not found. Use warehouse_list to see available connections."]],
            row_count=1,
            truncated=False,
        )

    try:
        connector.connect()
        rows = connector.execute(params.sql, limit=params.limit + 1)
        connector.close()

        if not rows:
            return SqlExecuteResult(
                columns=["status"],
                rows=[["Query executed successfully"]],
                row_count=0,
                truncated=False,
            )

        columns = list(rows[0].keys())
        truncated = len(rows) > params.limit
        if truncated:
            rows = rows[: params.limit]

        return SqlExecuteResult(
            columns=columns,
            rows=[list(row.values()) for row in rows],
            row_count=len(rows),
            truncated=truncated,
        )
    except Exception as e:
        return SqlExecuteResult(
            columns=["error"],
            rows=[[str(e)]],
            row_count=1,
            truncated=False,
        )


def _execute_postgres_raw(params: SqlExecuteParams) -> SqlExecuteResult:
    """Legacy fallback: execute SQL against a raw PostgreSQL connection string."""
    try:
        import psycopg2
    except ImportError:
        return SqlExecuteResult(
            columns=["error"],
            rows=[["psycopg2 not installed. Install with: pip install altimate-engine[warehouses]"]],
            row_count=1,
            truncated=False,
        )

    try:
        conn = psycopg2.connect(params.warehouse)
        cur = conn.cursor()
        cur.execute(params.sql)

        if cur.description is None:
            conn.commit()
            return SqlExecuteResult(
                columns=["status"],
                rows=[["Query executed successfully"]],
                row_count=cur.rowcount or 0,
                truncated=False,
            )

        columns = [desc[0] for desc in cur.description]
        rows = cur.fetchmany(params.limit + 1)
        truncated = len(rows) > params.limit
        if truncated:
            rows = rows[: params.limit]

        conn.close()
        return SqlExecuteResult(
            columns=columns,
            rows=[list(row) for row in rows],
            row_count=len(rows),
            truncated=truncated,
        )
    except Exception as e:
        return SqlExecuteResult(
            columns=["error"],
            rows=[[str(e)]],
            row_count=1,
            truncated=False,
        )
