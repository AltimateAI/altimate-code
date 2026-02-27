"""Schema change detection — compare two SQL model versions for breaking changes.

Purely static via sqlglot AST — no warehouse connection needed. Extracts output
columns from two SQL versions and compares them.

Change types:
  - DROPPED  → BREAKING — downstream models will fail
  - TYPE_CHANGED → WARNING — may cause silent data corruption
  - ADDED    → INFO — safe
  - RENAMED  → WARNING — detected via Levenshtein distance
"""

from __future__ import annotations

from typing import Any

import sqlglot
from sqlglot import exp


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def diff_schema(
    old_sql: str,
    new_sql: str,
    dialect: str = "snowflake",
    schema_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compare output columns of two SQL model versions.

    Args:
        old_sql: Previous version of the SQL model.
        new_sql: New version of the SQL model.
        dialect: SQL dialect (default: snowflake).
        schema_context: Optional schema for resolving SELECT *.

    Returns:
        Dict with changes, breaking status, and summary.
    """
    try:
        old_columns = _extract_output_columns(old_sql, dialect, schema_context)
    except Exception as e:
        return {
            "success": False,
            "changes": [],
            "has_breaking_changes": False,
            "summary": {},
            "error": f"Failed to parse old SQL: {e}",
        }

    try:
        new_columns = _extract_output_columns(new_sql, dialect, schema_context)
    except Exception as e:
        return {
            "success": False,
            "changes": [],
            "has_breaking_changes": False,
            "summary": {},
            "error": f"Failed to parse new SQL: {e}",
        }

    changes = _compare_columns(old_columns, new_columns)

    has_breaking = any(c["severity"] == "breaking" for c in changes)

    summary = {
        "old_column_count": len(old_columns),
        "new_column_count": len(new_columns),
        "dropped": sum(1 for c in changes if c["change_type"] == "DROPPED"),
        "added": sum(1 for c in changes if c["change_type"] == "ADDED"),
        "type_changed": sum(1 for c in changes if c["change_type"] == "TYPE_CHANGED"),
        "renamed": sum(1 for c in changes if c["change_type"] == "RENAMED"),
    }

    return {
        "success": True,
        "changes": changes,
        "has_breaking_changes": has_breaking,
        "summary": summary,
        "error": None,
    }


# ---------------------------------------------------------------------------
# Column extraction
# ---------------------------------------------------------------------------


class _ColumnInfo:
    """Represents an output column with name and optional type."""

    def __init__(self, name: str, data_type: str | None = None, expression: str | None = None):
        self.name = name
        self.data_type = data_type
        self.expression = expression

    def __repr__(self) -> str:
        return f"_ColumnInfo({self.name!r}, {self.data_type!r})"


def _extract_output_columns(
    sql: str,
    dialect: str,
    schema_context: dict[str, Any] | None = None,
) -> list[_ColumnInfo]:
    """Extract output column names and types from a SQL SELECT statement."""
    ast = sqlglot.parse_one(sql, dialect=dialect)

    # For UNION/UNION ALL, use the first branch
    if isinstance(ast, exp.Union):
        ast = ast.this  # First SELECT in the union

    if not isinstance(ast, exp.Select):
        return []

    columns: list[_ColumnInfo] = []
    for expr in ast.expressions:
        col_info = _resolve_expression_column(expr, ast, dialect, schema_context)
        if col_info is not None:
            if isinstance(col_info, list):
                columns.extend(col_info)
            else:
                columns.append(col_info)

    return columns


def _resolve_expression_column(
    expr: exp.Expression,
    select: exp.Select,
    dialect: str,
    schema_context: dict[str, Any] | None,
) -> _ColumnInfo | list[_ColumnInfo] | None:
    """Resolve a single SELECT expression to column info."""
    # Handle SELECT *
    if isinstance(expr, exp.Star):
        if schema_context:
            return _expand_star(select, schema_context)
        return _ColumnInfo("*", None, "*")

    # Handle aliased expressions: expr AS alias
    alias = expr.alias
    if alias:
        data_type = _infer_type(expr, dialect)
        return _ColumnInfo(alias, data_type, expr.sql(dialect=dialect))

    # Handle column references
    if isinstance(expr, exp.Column):
        return _ColumnInfo(expr.name, None, expr.sql(dialect=dialect))

    # Handle other expressions — use the SQL as the name
    sql_str = expr.sql(dialect=dialect)
    return _ColumnInfo(sql_str, _infer_type(expr, dialect), sql_str)


def _expand_star(
    select: exp.Select,
    schema_context: dict[str, Any],
) -> list[_ColumnInfo]:
    """Expand SELECT * using schema_context."""
    columns: list[_ColumnInfo] = []
    from_clause = select.find(exp.From)
    if not from_clause:
        return [_ColumnInfo("*", None, "*")]

    tables = list(from_clause.find_all(exp.Table))
    for join in select.find_all(exp.Join):
        tables.extend(join.find_all(exp.Table))

    for tbl in tables:
        tbl_name = tbl.name
        entry = schema_context.get(tbl_name)
        if entry is None:
            # Try case-insensitive
            for key, val in schema_context.items():
                if key.lower() == tbl_name.lower():
                    entry = val
                    break

        if entry is None:
            columns.append(_ColumnInfo("*", None, f"{tbl_name}.*"))
            continue

        if isinstance(entry, dict):
            for col_name, col_type in entry.items():
                columns.append(_ColumnInfo(col_name, str(col_type) if col_type else None))
        elif isinstance(entry, list):
            for col_name in entry:
                columns.append(_ColumnInfo(str(col_name), None))

    return columns


def _infer_type(expr: exp.Expression, dialect: str) -> str | None:
    """Attempt to infer the data type of an expression. Returns None if unknown."""
    # Unwrap Alias to get the inner expression
    inner = expr.this if isinstance(expr, exp.Alias) else expr

    if isinstance(inner, exp.Cast):
        to_type = inner.args.get("to")
        if to_type:
            return to_type.sql(dialect=dialect)
    if isinstance(inner, exp.Literal):
        if inner.is_string:
            return "VARCHAR"
        if inner.is_number:
            return "NUMBER"
    return None


# ---------------------------------------------------------------------------
# Column comparison
# ---------------------------------------------------------------------------


def _levenshtein(s1: str, s2: str) -> int:
    """Compute Levenshtein distance between two strings."""
    if len(s1) < len(s2):
        return _levenshtein(s2, s1)
    if len(s2) == 0:
        return len(s1)

    prev_row = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        curr_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = prev_row[j + 1] + 1
            deletions = curr_row[j] + 1
            substitutions = prev_row[j] + (c1 != c2)
            curr_row.append(min(insertions, deletions, substitutions))
        prev_row = curr_row

    return prev_row[-1]


def _compare_columns(
    old_columns: list[_ColumnInfo],
    new_columns: list[_ColumnInfo],
) -> list[dict[str, Any]]:
    """Compare old and new column lists to detect changes."""
    changes: list[dict[str, Any]] = []

    old_names = {c.name.lower(): c for c in old_columns}
    new_names = {c.name.lower(): c for c in new_columns}

    old_set = set(old_names.keys())
    new_set = set(new_names.keys())

    # Columns present in both
    common = old_set & new_set
    for name in sorted(common):
        old_col = old_names[name]
        new_col = new_names[name]
        # Check for type changes (only if both have types)
        if old_col.data_type and new_col.data_type:
            if old_col.data_type.upper() != new_col.data_type.upper():
                changes.append({
                    "column": old_col.name,
                    "change_type": "TYPE_CHANGED",
                    "severity": "warning",
                    "old_type": old_col.data_type,
                    "new_type": new_col.data_type,
                    "message": f"Column '{old_col.name}' type changed from {old_col.data_type} to {new_col.data_type}",
                })

    # Dropped columns
    dropped = old_set - new_set
    # Added columns
    added = new_set - old_set

    # Check for renames (Levenshtein distance < 3) among dropped/added pairs
    rename_pairs: list[tuple[str, str]] = []
    remaining_dropped = set(dropped)
    remaining_added = set(added)

    for d_name in sorted(dropped):
        best_match = None
        best_dist = 999
        for a_name in sorted(added):
            if a_name in remaining_added:
                dist = _levenshtein(d_name, a_name)
                if dist < best_dist and dist <= 2:
                    best_dist = dist
                    best_match = a_name

        if best_match is not None:
            rename_pairs.append((d_name, best_match))
            remaining_dropped.discard(d_name)
            remaining_added.discard(best_match)

    # Emit rename changes
    for old_name, new_name in rename_pairs:
        old_col = old_names[old_name]
        new_col = new_names[new_name]
        changes.append({
            "column": old_col.name,
            "change_type": "RENAMED",
            "severity": "warning",
            "new_name": new_col.name,
            "message": f"Column '{old_col.name}' appears to be renamed to '{new_col.name}'",
        })

    # Emit dropped changes
    for name in sorted(remaining_dropped):
        old_col = old_names[name]
        changes.append({
            "column": old_col.name,
            "change_type": "DROPPED",
            "severity": "breaking",
            "message": f"Column '{old_col.name}' was removed — downstream models will fail",
        })

    # Emit added changes
    for name in sorted(remaining_added):
        new_col = new_names[name]
        changes.append({
            "column": new_col.name,
            "change_type": "ADDED",
            "severity": "info",
            "message": f"Column '{new_col.name}' was added",
        })

    return changes
