"""Schema diff — detect column-level changes between two SQL SELECT statements."""

from __future__ import annotations

import difflib
from typing import Any

import sqlglot
from sqlglot import exp


def diff_schema(old_sql: str, new_sql: str, dialect: str = "ansi") -> dict[str, Any]:
    """Compare output columns of two SELECT statements and detect changes.

    Detects dropped columns, added columns, type changes (via CAST/alias hints),
    and renames (via Levenshtein similarity).

    Returns a dict matching SchemaDiffResult structure.
    """
    # sqlglot uses None for ANSI-standard SQL parsing
    effective_dialect = None if dialect in ("ansi", "", None) else dialect
    try:
        old_columns = _extract_columns(old_sql, effective_dialect)
        new_columns = _extract_columns(new_sql, effective_dialect)
    except Exception as e:
        return {
            "success": False,
            "changes": [],
            "has_breaking_changes": False,
            "summary": {},
            "error": f"Failed to parse SQL: {e}",
        }

    old_names = {c["name"] for c in old_columns}
    new_names = {c["name"] for c in new_columns}

    old_by_name = {c["name"]: c for c in old_columns}
    new_by_name = {c["name"]: c for c in new_columns}

    changes: list[dict[str, Any]] = []

    # Columns present in both: check for type changes
    for name in old_names & new_names:
        old_type = old_by_name[name].get("type")
        new_type = new_by_name[name].get("type")
        if old_type and new_type and old_type != new_type:
            changes.append({
                "column": name,
                "change_type": "TYPE_CHANGED",
                "severity": "warning",
                "message": f"Column `{name}` type changed from {old_type} to {new_type}",
                "old_type": old_type,
                "new_type": new_type,
                "new_name": None,
            })

    # Columns only in old (potentially dropped or renamed)
    dropped_candidates = old_names - new_names
    added_candidates = new_names - old_names

    # Try to match renames via similarity
    renamed_old: set[str] = set()
    renamed_new: set[str] = set()

    if dropped_candidates and added_candidates:
        for old_name in sorted(dropped_candidates):
            best_match = None
            best_ratio = 0.0
            for new_name in sorted(added_candidates - renamed_new):
                ratio = difflib.SequenceMatcher(None, old_name.lower(), new_name.lower()).ratio()
                if ratio > best_ratio:
                    best_ratio = ratio
                    best_match = new_name
            if best_match and best_ratio >= 0.6:
                renamed_old.add(old_name)
                renamed_new.add(best_match)
                changes.append({
                    "column": old_name,
                    "change_type": "RENAMED",
                    "severity": "warning",
                    "message": f"Column `{old_name}` appears renamed to `{best_match}` (similarity: {best_ratio:.0%})",
                    "old_type": old_by_name[old_name].get("type"),
                    "new_type": new_by_name[best_match].get("type"),
                    "new_name": best_match,
                })

    # Remaining drops
    for name in sorted(dropped_candidates - renamed_old):
        changes.append({
            "column": name,
            "change_type": "DROPPED",
            "severity": "breaking",
            "message": f"Column `{name}` was removed",
            "old_type": old_by_name[name].get("type"),
            "new_type": None,
            "new_name": None,
        })

    # Remaining additions
    for name in sorted(added_candidates - renamed_new):
        changes.append({
            "column": name,
            "change_type": "ADDED",
            "severity": "info",
            "message": f"Column `{name}` was added",
            "old_type": None,
            "new_type": new_by_name[name].get("type"),
            "new_name": None,
        })

    has_breaking = any(c["severity"] == "breaking" for c in changes)
    summary = {
        "total_changes": len(changes),
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


def _extract_columns(sql: str, dialect: str | None) -> list[dict[str, str | None]]:
    """Extract output column names and types from a SELECT statement."""
    parsed = sqlglot.parse(sql, dialect=dialect)
    if not parsed or not parsed[0]:
        raise ValueError("Could not parse SQL")

    stmt = parsed[0]
    select = stmt.find(exp.Select)
    if not select:
        raise ValueError("No SELECT clause found")

    columns: list[dict[str, str | None]] = []
    for expr in select.expressions:
        name = _resolve_alias_or_name(expr)
        col_type = _infer_type(expr)
        columns.append({"name": name, "type": col_type})

    return columns


def _resolve_alias_or_name(expr: exp.Expression) -> str:
    """Get the output name of a SELECT expression (alias or column name)."""
    if isinstance(expr, exp.Alias):
        return expr.alias
    if isinstance(expr, exp.Column):
        return expr.name
    # For functions, stars, etc. fall back to SQL representation
    if hasattr(expr, "alias") and expr.alias:
        return expr.alias
    # Use output_name if available (handles CAST etc.)
    if hasattr(expr, "output_name") and expr.output_name:
        return expr.output_name
    return expr.sql()


def _infer_type(expr: exp.Expression) -> str | None:
    """Try to infer the output type from CAST expressions or explicit type annotations."""
    # Unwrap alias to inspect the inner expression
    inner = expr.this if isinstance(expr, exp.Alias) else expr

    if isinstance(inner, exp.Cast):
        return inner.to.sql()

    # No explicit type information available
    return None
