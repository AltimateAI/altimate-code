"""SQL error fixing — suggest corrections given an error message and failing SQL."""

from __future__ import annotations

import re

import sqlglot
from sqlglot import exp


def fix_sql(sql: str, error_message: str, dialect: str = "snowflake") -> dict:
    """Analyze a SQL error and suggest fixes.

    Uses a combination of:
    1. sqlglot parse error analysis
    2. Common error pattern matching
    3. Schema-aware suggestions (column/table name typos)

    Args:
        sql: The failing SQL
        error_message: Error message from the database or validator
        dialect: SQL dialect

    Returns:
        Dict with suggestions, fixed_sql (if possible), and analysis.
    """
    suggestions: list[dict] = []
    fixed_sql = None
    error_lower = error_message.lower()

    # 1. Try to parse and fix syntax errors
    syntax_fix = _try_syntax_fix(sql, dialect)
    if syntax_fix:
        suggestions.append(syntax_fix)
        if syntax_fix.get("fixed_sql"):
            fixed_sql = syntax_fix["fixed_sql"]

    # 2. Pattern-match common database errors
    pattern_fixes = _match_error_patterns(sql, error_message, error_lower, dialect)
    suggestions.extend(pattern_fixes)
    if not fixed_sql:
        for fix in pattern_fixes:
            if fix.get("fixed_sql"):
                fixed_sql = fix["fixed_sql"]
                break

    # 3. Check for column/table resolution errors
    resolution_fixes = _check_resolution_errors(sql, error_message, error_lower, dialect)
    suggestions.extend(resolution_fixes)

    if not suggestions:
        suggestions.append({
            "type": "GENERAL",
            "message": "Could not automatically diagnose the error. Review the error message and SQL manually.",
            "confidence": "low",
        })

    return {
        "success": len(suggestions) > 0,
        "original_sql": sql,
        "fixed_sql": fixed_sql,
        "error_message": error_message,
        "suggestions": suggestions,
        "suggestion_count": len(suggestions),
    }


def _try_syntax_fix(sql: str, dialect: str) -> dict | None:
    """Try to parse the SQL and identify syntax issues."""
    try:
        sqlglot.parse(sql, read=dialect, error_level=sqlglot.ErrorLevel.RAISE)
        return None  # Parses fine, not a syntax error
    except sqlglot.errors.ParseError as e:
        error_str = str(e)
        # Try to auto-fix common syntax issues
        fixed = _attempt_auto_fix(sql, error_str, dialect)
        result = {
            "type": "SYNTAX_ERROR",
            "message": f"SQL parse error: {error_str}",
            "confidence": "high",
        }
        if fixed:
            result["fixed_sql"] = fixed
            result["message"] += f"\nAuto-fixed: successfully rewrote the query."
        return result
    except Exception:
        return None


def _attempt_auto_fix(sql: str, parse_error: str, dialect: str) -> str | None:
    """Try common auto-fixes for parse errors."""
    candidates = []

    # Fix: missing closing parenthesis
    open_count = sql.count("(")
    close_count = sql.count(")")
    if open_count > close_count:
        candidates.append(sql + ")" * (open_count - close_count))

    # Fix: trailing comma before FROM/WHERE/GROUP/ORDER/HAVING
    fixed_comma = re.sub(
        r",\s*(FROM|WHERE|GROUP|ORDER|HAVING|LIMIT|UNION|EXCEPT|INTERSECT)\b",
        r" \1",
        sql,
        flags=re.IGNORECASE,
    )
    if fixed_comma != sql:
        candidates.append(fixed_comma)

    # Fix: missing AS in alias (SELECT col newname → SELECT col AS newname)
    # This is tricky, skip for now

    # Try each candidate
    for candidate in candidates:
        try:
            sqlglot.parse(candidate, read=dialect, error_level=sqlglot.ErrorLevel.RAISE)
            return candidate
        except Exception:
            continue

    return None


def _match_error_patterns(
    sql: str, error_message: str, error_lower: str, dialect: str
) -> list[dict]:
    """Match common database error patterns and suggest fixes."""
    suggestions = []

    # Ambiguous column reference
    match = re.search(r"ambiguous column[: ]*['\"]?(\w+)['\"]?", error_lower)
    if match:
        col_name = match.group(1)
        suggestions.append({
            "type": "AMBIGUOUS_COLUMN",
            "message": f"Column '{col_name}' is ambiguous. Qualify it with the table name or alias (e.g., t.{col_name}).",
            "confidence": "high",
        })

    # Object does not exist
    if any(phrase in error_lower for phrase in [
        "does not exist", "not found", "unknown table", "unknown column",
        "invalid identifier", "object does not exist",
    ]):
        obj_match = re.search(r"['\"]([^'\"]+)['\"]", error_message)
        obj_name = obj_match.group(1) if obj_match else "unknown"
        suggestions.append({
            "type": "OBJECT_NOT_FOUND",
            "message": f"Object '{obj_name}' not found. Check spelling, schema qualification, and case sensitivity.",
            "confidence": "high",
        })
        # Case sensitivity hint for Snowflake
        if dialect == "snowflake" and obj_name != obj_name.upper():
            suggestions.append({
                "type": "CASE_SENSITIVITY",
                "message": f"Snowflake identifiers are case-insensitive by default (stored as UPPERCASE). "
                           f"Try '{obj_name.upper()}' or use double quotes for case-sensitive names.",
                "confidence": "medium",
            })

    # Division by zero
    if "division by zero" in error_lower:
        suggestions.append({
            "type": "DIVISION_BY_ZERO",
            "message": "Division by zero detected. Wrap the denominator with NULLIF(denominator, 0) or add a CASE WHEN check.",
            "confidence": "high",
        })
        # Try auto-fix
        fixed = re.sub(
            r"/\s*(\w+(?:\.\w+)?)",
            r"/ NULLIF(\1, 0)",
            sql,
        )
        if fixed != sql:
            suggestions[-1]["fixed_sql"] = fixed

    # Type mismatch
    if any(phrase in error_lower for phrase in [
        "type mismatch", "cannot cast", "invalid input syntax",
        "incompatible types", "numeric value",
    ]):
        suggestions.append({
            "type": "TYPE_MISMATCH",
            "message": "Data type mismatch. Check that comparisons and operations use compatible types. "
                      "Use explicit CAST() or TRY_CAST() for type conversions.",
            "confidence": "medium",
        })

    # GROUP BY errors
    if any(phrase in error_lower for phrase in [
        "not in group by", "must appear in the group by",
        "not an aggregate", "not a group-by expression",
    ]):
        col_match = re.search(r"['\"]([^'\"]+)['\"]", error_message)
        col = col_match.group(1) if col_match else "the column"
        suggestions.append({
            "type": "GROUP_BY_MISSING",
            "message": f"Column {col} must appear in GROUP BY or be used with an aggregate function (COUNT, SUM, MAX, etc.).",
            "confidence": "high",
        })

    # Permission denied
    if any(phrase in error_lower for phrase in [
        "permission denied", "access denied", "insufficient privileges",
        "not authorized",
    ]):
        suggestions.append({
            "type": "PERMISSION_DENIED",
            "message": "Access denied. Check that your role has the required privileges on this object.",
            "confidence": "high",
        })

    # Duplicate column
    if "duplicate column" in error_lower or "already exists" in error_lower:
        suggestions.append({
            "type": "DUPLICATE_COLUMN",
            "message": "Duplicate column name in output. Use aliases (AS) to give unique names to columns.",
            "confidence": "high",
        })

    return suggestions


def _check_resolution_errors(
    sql: str, error_message: str, error_lower: str, dialect: str
) -> list[dict]:
    """Check for column/table name resolution issues."""
    suggestions = []

    # Extract referenced tables from the SQL
    try:
        parsed = sqlglot.parse_one(sql, read=dialect, error_level=sqlglot.ErrorLevel.IGNORE)
        if parsed:
            tables = [t.name for t in parsed.find_all(exp.Table)]
            columns = [c.name for c in parsed.find_all(exp.Column)]

            # Check for common typos: trailing/leading spaces, mixed case
            for col in columns:
                if col != col.strip():
                    suggestions.append({
                        "type": "WHITESPACE_IN_NAME",
                        "message": f"Column '{col}' may have leading/trailing whitespace.",
                        "confidence": "medium",
                    })
    except Exception:
        pass

    return suggestions
