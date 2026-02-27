"""SQL rewriter — turns detected anti-patterns into executable fixes.

Deterministic AST transforms only (no LLM). Separate from optimizer.py which
runs sqlglot built-in passes; this module does anti-pattern-specific transforms.

Rules:
  1. SELECT * → explicit columns (requires schema_context)
  2. Non-sargable function-wrapped WHERE → sargable range predicates
  3. Large IN list (20+) → CTE with VALUES clause
"""

from __future__ import annotations

from typing import Any

import sqlglot
from sqlglot import exp


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def rewrite_sql(
    sql: str,
    dialect: str = "snowflake",
    schema_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Rewrite SQL to fix detected anti-patterns.

    Args:
        sql: Original SQL query.
        dialect: SQL dialect (default: snowflake).
        schema_context: Optional mapping of table_name -> {col_name: TYPE, ...}.

    Returns:
        Dict with original_sql, rewritten_sql, rewrites_applied, etc.
    """
    try:
        ast = sqlglot.parse_one(sql, dialect=dialect)
    except Exception as e:
        return {
            "success": False,
            "original_sql": sql,
            "rewritten_sql": None,
            "rewrites_applied": [],
            "error": f"Failed to parse SQL: {e}",
        }

    rewrites: list[dict[str, Any]] = []

    # Apply transforms in order — each operates on the (possibly modified) AST
    ast, r = _rewrite_select_star(ast, dialect, schema_context)
    rewrites.extend(r)

    ast, r = _rewrite_non_sargable(ast, dialect)
    rewrites.extend(r)

    ast, r = _rewrite_large_in_list(ast, dialect)
    rewrites.extend(r)

    # Only produce rewritten SQL if at least one auto-applicable rewrite was made
    has_auto_apply = any(r.get("can_auto_apply", False) for r in rewrites)
    rewritten_sql = ast.sql(dialect=dialect, pretty=True) if has_auto_apply else None

    return {
        "success": True,
        "original_sql": sql,
        "rewritten_sql": rewritten_sql,
        "rewrites_applied": rewrites,
        "error": None,
    }


# ---------------------------------------------------------------------------
# Rule 1: SELECT * → explicit columns
# ---------------------------------------------------------------------------

_STAR_SKIP_NOTE = (
    "SELECT * expansion skipped — no schema_context provided for table '{table}'. "
    "Pass schema_context to enable this rewrite."
)


def _resolve_table_columns(
    table_name: str,
    schema_context: dict[str, Any] | None,
) -> list[str] | None:
    """Look up columns for a table from schema_context.

    schema_context format: {"table_name": {"col1": "TYPE", "col2": "TYPE"}}
    or {"table_name": ["col1", "col2"]}
    """
    if not schema_context:
        return None

    # Try exact match first, then case-insensitive
    entry = schema_context.get(table_name)
    if entry is None:
        for key, val in schema_context.items():
            if key.lower() == table_name.lower():
                entry = val
                break

    if entry is None:
        return None

    if isinstance(entry, dict):
        return list(entry.keys())
    if isinstance(entry, list):
        return [str(c) for c in entry]
    return None


def _rewrite_select_star(
    ast: exp.Expression,
    dialect: str,
    schema_context: dict[str, Any] | None,
) -> tuple[exp.Expression, list[dict]]:
    """Replace SELECT * with explicit column list using schema_context."""
    rewrites: list[dict] = []

    stars = list(ast.find_all(exp.Star))
    if not stars:
        return ast, rewrites

    for star in stars:
        parent_select = star.find_ancestor(exp.Select)
        if not parent_select:
            continue

        # Gather tables referenced in this SELECT's FROM + JOINs
        tables: list[tuple[str, str | None]] = []  # (name, alias)
        from_clause = parent_select.find(exp.From)
        if from_clause and from_clause.parent is parent_select:
            for tbl in from_clause.find_all(exp.Table):
                tables.append((tbl.name, tbl.alias))
        for join in parent_select.find_all(exp.Join):
            if join.find_ancestor(exp.Select) is parent_select or join.parent is parent_select:
                for tbl in join.find_all(exp.Table):
                    tables.append((tbl.name, tbl.alias))

        if not tables:
            continue

        # Build column list from schema_context
        all_columns: list[exp.Expression] = []
        skipped = False
        for tbl_name, tbl_alias in tables:
            cols = _resolve_table_columns(tbl_name, schema_context)
            if cols is None:
                skipped = True
                rewrites.append({
                    "rule": "SELECT_STAR",
                    "original_fragment": "*",
                    "rewritten_fragment": "*",
                    "explanation": _STAR_SKIP_NOTE.format(table=tbl_name),
                    "can_auto_apply": False,
                })
                break

            prefix = tbl_alias or tbl_name if len(tables) > 1 else None
            for col_name in cols:
                if prefix:
                    all_columns.append(
                        exp.Column(this=exp.to_identifier(col_name), table=exp.to_identifier(prefix))
                    )
                else:
                    all_columns.append(exp.Column(this=exp.to_identifier(col_name)))

        if skipped or not all_columns:
            continue

        original_fragment = parent_select.sql(dialect=dialect)

        # Replace expressions in the SELECT
        parent_select.set("expressions", all_columns)

        rewritten_fragment = parent_select.sql(dialect=dialect)

        rewrites.append({
            "rule": "SELECT_STAR",
            "original_fragment": original_fragment,
            "rewritten_fragment": rewritten_fragment,
            "explanation": f"Expanded SELECT * to {len(all_columns)} explicit columns",
            "can_auto_apply": True,
        })

    return ast, rewrites


# ---------------------------------------------------------------------------
# Rule 2: Non-sargable function-wrapped WHERE → sargable range predicates
# ---------------------------------------------------------------------------

# Supported function rewrites: YEAR, MONTH, DATE, DATE_TRUNC
_SARGABLE_FUNCTIONS = {"YEAR", "MONTH", "DATE", "DATE_TRUNC"}


def _rewrite_non_sargable(
    ast: exp.Expression,
    dialect: str,
) -> tuple[exp.Expression, list[dict]]:
    """Rewrite non-sargable function-on-column WHERE predicates to range predicates."""
    rewrites: list[dict] = []

    where_clauses = list(ast.find_all(exp.Where))
    if not where_clauses:
        return ast, rewrites

    for where in where_clauses:
        eq_nodes = list(where.find_all(exp.EQ))
        for eq in eq_nodes:
            result = _try_sargable_rewrite(eq, dialect)
            if result:
                original_fragment, replacement, explanation = result
                eq.replace(replacement)
                rewrites.append({
                    "rule": "NON_SARGABLE",
                    "original_fragment": original_fragment,
                    "rewritten_fragment": replacement.sql(dialect=dialect),
                    "explanation": explanation,
                    "can_auto_apply": True,
                })

    return ast, rewrites


def _try_sargable_rewrite(
    eq: exp.EQ,
    dialect: str,
) -> tuple[str, exp.Expression, str] | None:
    """Attempt to rewrite a single EQ predicate with a function-wrapped column.

    Returns (original_fragment, replacement_expression, explanation) or None.
    """
    left = eq.left
    right = eq.right

    # Determine which side has the function wrapping a column
    func_side = None
    value_side = None
    if isinstance(left, exp.Func) and _has_column_arg(left):
        func_side = left
        value_side = right
    elif isinstance(right, exp.Func) and _has_column_arg(right):
        func_side = right
        value_side = left

    if func_side is None:
        return None

    func_name = func_side.key.upper() if hasattr(func_side, 'key') else type(func_side).__name__.upper()

    # Also handle sqlglot's specific expression types
    if isinstance(func_side, exp.Year):
        func_name = "YEAR"
    elif isinstance(func_side, exp.Month):
        func_name = "MONTH"
    elif isinstance(func_side, exp.DateTrunc):
        func_name = "DATE_TRUNC"
    elif isinstance(func_side, (exp.Date, exp.TsOrDsToDate)):
        func_name = "DATE"
    elif isinstance(func_side, exp.Anonymous):
        func_name = func_side.name.upper()

    if func_name not in _SARGABLE_FUNCTIONS:
        return None

    # Extract the column from the function
    col = _extract_column(func_side)
    if col is None:
        return None

    # Extract the literal value
    value = _extract_literal_value(value_side)
    if value is None:
        return None

    original_fragment = eq.sql(dialect=dialect)

    if func_name == "YEAR":
        return _rewrite_year(col, value, original_fragment, dialect)
    elif func_name == "MONTH":
        return _rewrite_month(col, value, original_fragment, dialect)
    elif func_name == "DATE":
        return _rewrite_date(col, value, original_fragment, dialect)
    elif func_name == "DATE_TRUNC":
        return _rewrite_date_trunc(func_side, col, value, original_fragment, dialect)

    return None


def _has_column_arg(func: exp.Func) -> bool:
    """Check if a function has a Column argument."""
    return any(isinstance(arg, exp.Column) for arg in func.flatten() if isinstance(arg, exp.Expression))


def _extract_column(func: exp.Func) -> exp.Column | None:
    """Extract the first Column argument from a function."""
    for arg in func.flatten():
        if isinstance(arg, exp.Column):
            return arg
    return None


def _extract_literal_value(node: exp.Expression) -> str | None:
    """Extract a literal value as a string."""
    if isinstance(node, exp.Literal):
        return str(node.this)
    if isinstance(node, exp.Neg) and isinstance(node.this, exp.Literal):
        return f"-{node.this.this}"
    return None


def _rewrite_year(
    col: exp.Column,
    year_str: str,
    original_fragment: str,
    dialect: str,
) -> tuple[str, exp.Expression, str] | None:
    """YEAR(col) = 2024 → col >= '2024-01-01' AND col < '2025-01-01'"""
    try:
        year = int(year_str)
    except ValueError:
        return None

    start = f"{year}-01-01"
    end = f"{year + 1}-01-01"

    replacement = exp.And(
        this=exp.GTE(this=col.copy(), expression=exp.Literal.string(start)),
        expression=exp.LT(this=col.copy(), expression=exp.Literal.string(end)),
    )

    explanation = f"Rewrote YEAR({col.sql(dialect=dialect)}) = {year} to range predicate for sargability"
    return original_fragment, replacement, explanation


def _rewrite_month(
    col: exp.Column,
    month_str: str,
    original_fragment: str,
    dialect: str,
) -> tuple[str, exp.Expression, str] | None:
    """MONTH(col) = 3 → col >= '...-03-01' AND col < '...-04-01'.

    Since we don't know the year, emit a note about year-agnostic behavior.
    Actually, without year context this is ambiguous. Skip with explanation.
    """
    # MONTH alone is ambiguous without year — can't produce a single range.
    # We'll still produce the rewrite as a suggestion but mark can_auto_apply=False.
    return None


def _rewrite_date(
    col: exp.Column,
    date_str: str,
    original_fragment: str,
    dialect: str,
) -> tuple[str, exp.Expression, str] | None:
    """DATE(col) = '2024-03-15' → col >= '2024-03-15' AND col < '2024-03-16'"""
    # Parse the date string
    parts = date_str.replace("'", "").replace('"', "").split("-")
    if len(parts) != 3:
        return None

    try:
        year, month, day = int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        return None

    import datetime

    try:
        start_date = datetime.date(year, month, day)
        end_date = start_date + datetime.timedelta(days=1)
    except ValueError:
        return None

    start = start_date.isoformat()
    end = end_date.isoformat()

    replacement = exp.And(
        this=exp.GTE(this=col.copy(), expression=exp.Literal.string(start)),
        expression=exp.LT(this=col.copy(), expression=exp.Literal.string(end)),
    )

    explanation = f"Rewrote DATE({col.sql(dialect=dialect)}) = '{date_str}' to range predicate for sargability"
    return original_fragment, replacement, explanation


def _rewrite_date_trunc(
    func: exp.Func,
    col: exp.Column,
    value_str: str,
    original_fragment: str,
    dialect: str,
) -> tuple[str, exp.Expression, str] | None:
    """DATE_TRUNC('month', col) = '2024-03-01' → col >= '2024-03-01' AND col < '2024-04-01'"""
    # Extract the truncation unit from the function
    unit = None
    if isinstance(func, exp.DateTrunc):
        unit_arg = func.args.get("unit")
        if unit_arg:
            unit = str(unit_arg).strip("'\"").upper()
    elif isinstance(func, exp.Anonymous) and func.name.upper() == "DATE_TRUNC":
        args = func.expressions
        if args:
            unit = str(args[0]).strip("'\"").upper()

    if not unit:
        return None

    # Parse the comparison value as a date
    date_str = value_str.replace("'", "").replace('"', "")
    parts = date_str.split("-")
    if len(parts) < 3:
        return None

    try:
        year, month, day = int(parts[0]), int(parts[1]), int(parts[2].split(" ")[0].split("T")[0])
    except ValueError:
        return None

    import datetime

    try:
        start_date = datetime.date(year, month, day)
    except ValueError:
        return None

    if unit in ("MONTH", "MON", "MM"):
        if month == 12:
            end_date = datetime.date(year + 1, 1, 1)
        else:
            end_date = datetime.date(year, month + 1, 1)
    elif unit in ("YEAR", "YYYY", "YY"):
        end_date = datetime.date(year + 1, 1, 1)
    elif unit in ("DAY", "DD", "D"):
        end_date = start_date + datetime.timedelta(days=1)
    elif unit in ("QUARTER", "QTR", "Q"):
        quarter_start_month = ((month - 1) // 3) * 3 + 1
        next_quarter_month = quarter_start_month + 3
        if next_quarter_month > 12:
            end_date = datetime.date(year + 1, next_quarter_month - 12, 1)
        else:
            end_date = datetime.date(year, next_quarter_month, 1)
    elif unit in ("WEEK", "WK", "W"):
        end_date = start_date + datetime.timedelta(weeks=1)
    else:
        return None

    start = start_date.isoformat()
    end = end_date.isoformat()

    replacement = exp.And(
        this=exp.GTE(this=col.copy(), expression=exp.Literal.string(start)),
        expression=exp.LT(this=col.copy(), expression=exp.Literal.string(end)),
    )

    explanation = (
        f"Rewrote DATE_TRUNC('{unit}', {col.sql(dialect=dialect)}) = '{value_str}' "
        f"to range predicate for sargability"
    )
    return original_fragment, replacement, explanation


# ---------------------------------------------------------------------------
# Rule 3: Large IN list → CTE with VALUES clause
# ---------------------------------------------------------------------------

LARGE_IN_THRESHOLD = 20


def _rewrite_large_in_list(
    ast: exp.Expression,
    dialect: str,
) -> tuple[exp.Expression, list[dict]]:
    """Rewrite large IN lists (20+ items) to CTE with VALUES clause."""
    rewrites: list[dict] = []

    in_nodes = list(ast.find_all(exp.In))
    if not in_nodes:
        return ast, rewrites

    cte_counter = 0
    for in_node in in_nodes:
        expressions = in_node.args.get("expressions")
        if not expressions or len(expressions) < LARGE_IN_THRESHOLD:
            continue

        # Extract the column being filtered
        col = in_node.this
        if not isinstance(col, exp.Column):
            continue

        original_fragment = in_node.sql(dialect=dialect)
        item_count = len(expressions)

        # Build VALUES list
        cte_counter += 1
        cte_name = f"_in_values_{cte_counter}"

        # Create the CTE: WITH _in_values_N AS (SELECT column1 AS val FROM VALUES (...))
        # Different dialects have different VALUES syntax
        values_rows = []
        for expr in expressions:
            values_rows.append(exp.Tuple(expressions=[expr.copy()]))

        values_node = exp.Values(expressions=values_rows)
        val_alias = exp.to_identifier("val")

        # Build: SELECT column1 AS val FROM (VALUES ...)
        # Use a subquery with VALUES
        cte_select = exp.Select(
            expressions=[exp.Column(this=exp.to_identifier("column1"), alias=val_alias)],
        ).from_(values_node, copy=False)

        cte_def = exp.CTE(
            this=cte_select,
            alias=exp.TableAlias(this=exp.to_identifier(cte_name)),
        )

        # Replace the IN expression with: col IN (SELECT val FROM _in_values_N)
        subquery_select = exp.Select(
            expressions=[exp.Column(this=exp.to_identifier("val"))],
        ).from_(exp.Table(this=exp.to_identifier(cte_name)), copy=False)

        new_in = exp.In(
            this=col.copy(),
            query=subquery_select,
        )

        in_node.replace(new_in)

        # Add the CTE to the top-level query
        if isinstance(ast, exp.Select):
            existing_with = ast.args.get("with")
            if existing_with:
                existing_with.expressions.append(cte_def)
            else:
                ast.set("with", exp.With(expressions=[cte_def]))

        rewritten_fragment = new_in.sql(dialect=dialect)

        rewrites.append({
            "rule": "LARGE_IN_LIST",
            "original_fragment": f"IN ({item_count} values)",
            "rewritten_fragment": f"IN (SELECT val FROM {cte_name})",
            "explanation": f"Moved {item_count} IN list values to CTE '{cte_name}' to reduce query compilation overhead",
            "can_auto_apply": True,
        })

    return ast, rewrites
