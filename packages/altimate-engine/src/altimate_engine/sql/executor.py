"""SQL execution against warehouse connections."""

from __future__ import annotations

from altimate_engine.models import SqlExecuteParams, SqlExecuteResult


def execute_sql(params: SqlExecuteParams) -> SqlExecuteResult:
    """Execute SQL against a warehouse connection.

    Currently a stub — will be extended with real warehouse connectors
    (psycopg2, snowflake-connector-python) in a future phase.
    """
    if params.warehouse and params.warehouse.startswith("postgres"):
        return _execute_postgres(params)

    # Stub response for unsupported/unconfigured warehouses
    return SqlExecuteResult(
        columns=["info"],
        rows=[["SQL execution not configured. Install warehouse extras: pip install altimate-engine[warehouses]"]],
        row_count=1,
        truncated=False,
    )


def _execute_postgres(params: SqlExecuteParams) -> SqlExecuteResult:
    """Execute SQL against a PostgreSQL database."""
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
