"""SQL EXPLAIN — run execution plans via warehouse connectors."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry
from altimate_engine.models import SqlExplainParams, SqlExplainResult


def explain_sql(params: SqlExplainParams) -> SqlExplainResult:
    """Run EXPLAIN on a SQL query and return the execution plan.

    Adapts the EXPLAIN syntax per dialect:
    - Snowflake: EXPLAIN USING TEXT <sql>
    - Postgres:  EXPLAIN (FORMAT TEXT) <sql>  or EXPLAIN ANALYZE
    - DuckDB:    EXPLAIN <sql>
    """
    if not params.warehouse:
        return SqlExplainResult(
            success=False,
            plan_text=None,
            plan_rows=[],
            error="No warehouse specified. Use warehouse_list to see available connections.",
        )

    try:
        connector = ConnectionRegistry.get(params.warehouse)
    except ValueError:
        return SqlExplainResult(
            success=False,
            plan_text=None,
            plan_rows=[],
            error=f"Connection '{params.warehouse}' not found. Use warehouse_list to see available connections.",
        )

    # Determine warehouse type from registry
    wh_type = "unknown"
    for wh in ConnectionRegistry.list():
        if wh["name"] == params.warehouse:
            wh_type = wh.get("type", "unknown")
            break

    # Build the EXPLAIN query
    explain_sql_str = _build_explain_query(params.sql, wh_type, params.analyze)

    try:
        connector.connect()
        try:
            connector.set_statement_timeout(60_000)
            rows = connector.execute(explain_sql_str)
        finally:
            connector.close()

        if not rows:
            return SqlExplainResult(
                success=True,
                plan_text="(empty plan)",
                plan_rows=[],
                warehouse_type=wh_type,
                analyzed=params.analyze,
            )

        # Extract plan text — different warehouses return different column names
        plan_lines = []
        plan_rows_out = []
        for row in rows:
            row_dict = dict(row) if not isinstance(row, dict) else row
            plan_rows_out.append(row_dict)
            # Try common column names for plan text
            for key in ("QUERY PLAN", "queryPlan", "plan", "rows", "content",
                        "EXPLAIN", "explain"):
                if key in row_dict:
                    plan_lines.append(str(row_dict[key]))
                    break
            else:
                # Just join all values as a line
                plan_lines.append(" | ".join(str(v) for v in row_dict.values()))

        plan_text = "\n".join(plan_lines)

        return SqlExplainResult(
            success=True,
            plan_text=plan_text,
            plan_rows=plan_rows_out,
            warehouse_type=wh_type,
            analyzed=params.analyze,
        )
    except Exception as e:
        return SqlExplainResult(
            success=False,
            plan_text=None,
            plan_rows=[],
            error=str(e),
            warehouse_type=wh_type,
        )


def _build_explain_query(sql: str, wh_type: str, analyze: bool) -> str:
    """Build dialect-appropriate EXPLAIN query."""
    # Strip trailing semicolons from the inner query
    sql_clean = sql.rstrip().rstrip(";")

    if wh_type == "snowflake":
        # Snowflake doesn't support EXPLAIN ANALYZE
        return f"EXPLAIN USING TEXT {sql_clean}"
    elif wh_type == "postgres":
        if analyze:
            return f"EXPLAIN (ANALYZE, FORMAT TEXT) {sql_clean}"
        return f"EXPLAIN (FORMAT TEXT) {sql_clean}"
    elif wh_type == "duckdb":
        if analyze:
            return f"EXPLAIN ANALYZE {sql_clean}"
        return f"EXPLAIN {sql_clean}"
    else:
        # Generic fallback
        prefix = "EXPLAIN ANALYZE" if analyze else "EXPLAIN"
        return f"{prefix} {sql_clean}"
