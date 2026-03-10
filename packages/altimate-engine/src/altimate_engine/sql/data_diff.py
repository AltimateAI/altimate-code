"""Deterministic data diff engine using altimate-core's reladiff state machine.

Orchestrates the cooperative Rust state machine: creates a session, loops
start() → execute SQL → step() until Done or Error. All SQL execution goes
through the existing ConnectionRegistry.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from altimate_engine.connections import ConnectionRegistry
from altimate_engine.models import SqlExecuteParams
from altimate_engine.sql.executor import execute_sql

logger = logging.getLogger(__name__)

try:
    import altimate_core

    RELADIFF_AVAILABLE = True
except ImportError:
    RELADIFF_AVAILABLE = False

# Map TableSide enum values to warehouse names
_SIDE_MAP = {"Table1": "source", "Table2": "target"}


def _resolve_dialect(warehouse_name: str) -> str:
    """Infer SQL dialect from connection type."""
    try:
        conn = ConnectionRegistry.get(warehouse_name)
        conn_type = getattr(conn, "type", "").lower()
        dialect_map = {
            "snowflake": "snowflake",
            "duckdb": "duckdb",
            "postgres": "postgres",
            "postgresql": "postgres",
            "bigquery": "bigquery",
            "mysql": "mysql",
            "clickhouse": "clickhouse",
            "databricks": "databricks",
            "redshift": "redshift",
        }
        return dialect_map.get(conn_type, "generic")
    except Exception:
        return "generic"


def _execute_task(task: dict, warehouse: str) -> dict:
    """Execute a single SQL task against the given warehouse."""
    result = execute_sql(
        SqlExecuteParams(sql=task["sql"], warehouse=warehouse, limit=100_000)
    )

    # Convert SqlExecuteResult rows to the format expected by ReladiffSession.step()
    rows: list[list[str | None]] = []
    for row in result.rows:
        rows.append([str(v) if v is not None else None for v in row])

    return {"id": task["id"], "rows": rows}


def run_data_diff(
    *,
    source_table: str,
    target_table: str,
    source_warehouse: str,
    target_warehouse: str | None = None,
    key_columns: list[str],
    extra_columns: list[str] | None = None,
    algorithm: str = "auto",
    where_clause: str | None = None,
    source_database: str | None = None,
    source_schema: str | None = None,
    target_database: str | None = None,
    target_schema: str | None = None,
) -> dict[str, Any]:
    """Run a deterministic data diff using the Rust reladiff engine.

    Returns the complete validation result as a dict.
    """
    if not RELADIFF_AVAILABLE:
        return {
            "success": False,
            "error": "altimate-core not installed. ReladiffSession unavailable.",
        }

    target_warehouse = target_warehouse or source_warehouse

    # Resolve dialects from connection types
    dialect1 = _resolve_dialect(source_warehouse)
    dialect2 = _resolve_dialect(target_warehouse)

    # Build session spec
    table1: dict[str, Any] = {"table": source_table}
    if source_database:
        table1["database"] = source_database
    if source_schema:
        table1["schema"] = source_schema

    table2: dict[str, Any] = {"table": target_table}
    if target_database:
        table2["database"] = target_database
    if target_schema:
        table2["schema"] = target_schema

    spec = {
        "table1": table1,
        "table2": table2,
        "dialect1": dialect1,
        "dialect2": dialect2,
        "config": {
            "algorithm": algorithm,
            "key_columns": key_columns,
            "extra_columns": extra_columns or [],
        },
    }

    if where_clause:
        spec["config"]["where_clause"] = where_clause

    logger.info("Starting reladiff session: %s", json.dumps(spec, indent=2))

    # Create session and run the state machine loop
    try:
        session = altimate_core.ReladiffSession(json.dumps(spec))
    except Exception as e:
        return {"success": False, "error": f"Failed to create session: {e}"}

    # Map table sides to warehouses
    warehouse_map = {"Table1": source_warehouse, "Table2": target_warehouse}

    action = session.start()
    step_count = 0
    max_steps = 100  # Safety limit

    while step_count < max_steps:
        step_count += 1
        action_type = action.get("type")

        if action_type == "Done":
            outcome = action.get("outcome", {})
            return {
                "success": True,
                "status": "completed",
                "steps": step_count,
                "outcome": outcome,
            }

        if action_type == "Error":
            return {
                "success": False,
                "error": action.get("message", "Unknown engine error"),
                "steps": step_count,
            }

        if action_type != "ExecuteSql":
            return {
                "success": False,
                "error": f"Unexpected action type: {action_type}",
                "steps": step_count,
            }

        # Execute all SQL tasks
        tasks = action.get("tasks", [])
        responses = []

        for task in tasks:
            side = task.get("table_side", "Table1")
            wh = warehouse_map.get(side, source_warehouse)

            logger.info(
                "Step %d: Executing [%s] on %s: %s",
                step_count,
                side,
                wh,
                task["sql"][:120],
            )

            try:
                resp = _execute_task(task, wh)
                responses.append(resp)
            except Exception as e:
                return {
                    "success": False,
                    "error": f"SQL execution failed on {wh}: {e}",
                    "steps": step_count,
                    "failed_sql": task["sql"],
                }

        # Feed responses back to the engine
        action = session.step(json.dumps(responses))

    return {
        "success": False,
        "error": f"State machine did not converge after {max_steps} steps",
        "steps": step_count,
    }
