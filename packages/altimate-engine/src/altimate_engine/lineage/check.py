"""Lineage check implementation using sqlglot."""

from __future__ import annotations

from typing import Any

import sqlglot
from sqlglot import exp

from altimate_engine.models import (
    LineageCheckParams,
    LineageCheckResult,
    LineageEdge,
    ModelColumn,
)


def check_lineage(params: LineageCheckParams) -> LineageCheckResult:
    """Check column-level lineage from SQL.

    Args:
        params: LineageCheckParams containing SQL and optional schema context

    Returns:
        LineageCheckResult with edges, tables, and columns
    """
    sql = params.sql
    dialect = params.dialect or "snowflake"

    # Check for Jinja/macro before parsing (parse will fail on Jinja syntax)
    pre_parse_factors: list[str] = []
    if "{{" in sql or "}}" in sql:
        pre_parse_factors.append(
            "Jinja/macro detected — suggest using manifest lineage instead"
        )

    try:
        ast = sqlglot.parse_one(sql, dialect=dialect)
    except Exception as e:
        confidence = "low" if pre_parse_factors else "high"
        factors = list(pre_parse_factors)
        if params.schema_context is None:
            if not pre_parse_factors:
                confidence = "medium"
            factors.append(
                "No schema context provided — best-effort lineage only"
            )
        return LineageCheckResult(
            edges=[],
            tables=[],
            columns=[],
            confidence=confidence,
            confidence_factors=factors,
        )

    edges: list[LineageEdge] = []
    tables: set[str] = set()
    columns: set[str] = set()

    source_columns: dict[str, set[str]] = {}

    for select in ast.find_all(exp.Select):
        target_columns = _get_target_columns(select)

        for source in select.find_all(exp.Column):
            table_name = source.table
            column_name = source.name

            if table_name:
                tables.add(table_name)
            columns.add(column_name)

            if table_name not in source_columns:
                source_columns[table_name] = set()
            source_columns[table_name].add(column_name)

        for target_col, source_exp in target_columns.items():
            columns.add(target_col)

            if isinstance(source_exp, exp.Column):
                source_table = source_exp.table or "unknown"
                source_col = source_exp.name

                edges.append(
                    LineageEdge(
                        source_table=source_table,
                        source_column=source_col,
                        target_table=_get_target_table(select),
                        target_column=target_col,
                        transform=None,
                    )
                )
                tables.add(source_table)
                tables.add(_get_target_table(select))

            elif isinstance(source_exp, exp.Alias):
                alias_col = source_exp.alias
                source = source_exp.this

                if isinstance(source, exp.Column):
                    source_table = source.table or "unknown"
                    source_col = source.name

                    edges.append(
                        LineageEdge(
                            source_table=source_table,
                            source_column=source_col,
                            target_table=_get_target_table(select),
                            target_column=alias_col,
                            transform=f"ALIAS: {source_exp.sql(dialect)}",
                        )
                    )
                    tables.add(source_table)
                    tables.add(_get_target_table(select))
                else:
                    # For Alias(Func), Alias(Window), Alias(Case), etc.
                    # extract all Column references from the expression
                    target_table = _get_target_table(select)
                    for inner_col in source.find_all(exp.Column):
                        src_table = inner_col.table or "unknown"
                        edges.append(
                            LineageEdge(
                                source_table=src_table,
                                source_column=inner_col.name,
                                target_table=target_table,
                                target_column=alias_col,
                                transform=f"{type(source).__name__.upper()}: {source_exp.sql(dialect)}",
                            )
                        )
                        tables.add(src_table)
                        tables.add(target_table)

    # Compute confidence signals
    confidence = "high"
    confidence_factors: list[str] = []

    # SELECT * creates ambiguous column mapping
    if list(ast.find_all(exp.Star)):
        confidence = "low"
        confidence_factors.append(
            "SELECT * creates ambiguous column mapping"
        )

    # Jinja/macro detection in raw SQL
    if pre_parse_factors:
        confidence = "low"
        confidence_factors.extend(pre_parse_factors)

    # No schema context provided
    if params.schema_context is None:
        if confidence == "high":
            confidence = "medium"
        confidence_factors.append(
            "No schema context provided — best-effort lineage only"
        )

    # Large lineage graph
    if len(edges) > 1000:
        if confidence == "high":
            confidence = "medium"
        confidence_factors.append(
            "Large lineage graph — output may be truncated"
        )

    return LineageCheckResult(
        edges=edges,
        tables=list(tables),
        columns=list(columns),
        confidence=confidence,
        confidence_factors=confidence_factors,
    )


def _get_target_columns(select: exp.Select) -> dict[str, exp.Expression]:
    """Extract target column names and their source expressions."""
    result = {}

    select_expressions = select.expressions

    for i, expr in enumerate(select_expressions):
        if isinstance(expr, exp.Alias):
            target_col = expr.alias
            result[target_col] = expr
        elif isinstance(expr, exp.Column):
            target_col = expr.name
            result[target_col] = expr
        elif isinstance(expr, (exp.Func, exp.Window)):
            target_col = f"expr_{i}"
            result[target_col] = expr

    return result


def _get_target_table(select: exp.Select) -> str:
    """Get the target table name from a SELECT statement.

    Uses find(exp.From) for sqlglot v29 compatibility (key is 'from_' not 'from').
    Only considers the FROM clause that belongs directly to this SELECT.
    Handles subqueries in FROM by using the subquery alias.
    """
    from_clause = select.find(exp.From)
    if from_clause and from_clause.parent is select:
        # Check for subquery in FROM first — use its alias
        for child in from_clause.args.get("expressions", [from_clause.this] if from_clause.this else []):
            if isinstance(child, exp.Subquery):
                alias = child.alias
                if alias:
                    return alias
            elif isinstance(child, exp.Table):
                return child.alias_or_name
        # Fallback: find the first direct table (not recursing into subqueries)
        first_expr = from_clause.this
        if first_expr is not None:
            if isinstance(first_expr, exp.Subquery):
                return first_expr.alias or "unknown"
            if isinstance(first_expr, exp.Table):
                return first_expr.alias_or_name
    return "unknown"
