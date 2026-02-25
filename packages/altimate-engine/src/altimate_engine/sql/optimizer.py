"""SQL query optimization using sqlglot's optimizer and static analysis."""

from __future__ import annotations

from typing import Any

import sqlglot
from sqlglot import exp
from sqlglot.optimizer import (
    eliminate_ctes,
    eliminate_subqueries,
    merge_subqueries,
    normalize_identifiers,
    optimize,
    simplify,
)

from altimate_engine.sql.analyzer import analyze_sql


# Maps anti-pattern types from the analyzer to optimization suggestions.
_ANTI_PATTERN_SUGGESTIONS: dict[str, dict[str, str]] = {
    "SELECT_STAR": {
        "type": "REWRITE",
        "description": "Replace SELECT * with explicit column list to reduce data transfer",
        "impact": "high",
    },
    "SELECT_STAR_IN_SUBQUERY": {
        "type": "REWRITE",
        "description": "Replace SELECT * in subquery with only the columns needed by the outer query",
        "impact": "high",
    },
    "UNION_INSTEAD_OF_UNION_ALL": {
        "type": "REWRITE",
        "description": "Use UNION ALL instead of UNION to skip expensive deduplication",
        "impact": "high",
    },
    "ORDER_BY_WITHOUT_LIMIT": {
        "type": "PERFORMANCE",
        "description": "Add LIMIT clause to ORDER BY to avoid sorting the entire result set",
        "impact": "medium",
    },
    "CORRELATED_SUBQUERY": {
        "type": "REWRITE",
        "description": "Rewrite correlated subquery as a JOIN or CTE to avoid N+1 execution",
        "impact": "high",
    },
    "FUNCTION_IN_FILTER": {
        "type": "PERFORMANCE",
        "description": "Restructure filter to avoid function on column, enabling partition pruning",
        "impact": "medium",
    },
    "FUNCTION_IN_JOIN": {
        "type": "PERFORMANCE",
        "description": "Remove function from JOIN condition to allow optimal join pruning",
        "impact": "medium",
    },
    "UNUSED_CTE": {
        "type": "STRUCTURE",
        "description": "Remove unused CTE to simplify the query",
        "impact": "low",
    },
    "NOT_IN_WITH_SUBQUERY": {
        "type": "REWRITE",
        "description": "Replace NOT IN with NOT EXISTS or LEFT JOIN IS NULL for correct NULL handling and better performance",
        "impact": "high",
    },
    "LIKE_LEADING_WILDCARD": {
        "type": "PERFORMANCE",
        "description": "Leading wildcard in LIKE prevents index/clustering key usage",
        "impact": "medium",
    },
    "LARGE_IN_LIST": {
        "type": "REWRITE",
        "description": "Replace large IN list with CTE VALUES clause or temporary table",
        "impact": "medium",
    },
    "CARTESIAN_PRODUCT": {
        "type": "STRUCTURE",
        "description": "CROSS JOIN creates a Cartesian product — verify this is intentional",
        "impact": "high",
    },
    "IMPLICIT_CARTESIAN": {
        "type": "STRUCTURE",
        "description": "Implicit comma join without WHERE creates a Cartesian product — add explicit JOIN conditions",
        "impact": "high",
    },
    "OR_IN_JOIN": {
        "type": "REWRITE",
        "description": "Split OR condition in JOIN into separate JOINs with UNION ALL for better optimization",
        "impact": "medium",
    },
    "NON_EQUI_JOIN": {
        "type": "PERFORMANCE",
        "description": "Non-equi join may produce large intermediate results — add an equality condition if possible",
        "impact": "medium",
    },
    "WINDOW_WITHOUT_PARTITION": {
        "type": "PERFORMANCE",
        "description": "Add PARTITION BY to window function to limit scope and improve performance",
        "impact": "low",
    },
    "GROUP_BY_PRIMARY_KEY": {
        "type": "STRUCTURE",
        "description": "GROUP BY on a unique key column produces one group per row — verify intent",
        "impact": "low",
    },
    "ORDER_BY_IN_SUBQUERY": {
        "type": "REWRITE",
        "description": "Remove ORDER BY in subquery (has no effect without LIMIT) to eliminate sorting overhead",
        "impact": "medium",
    },
    "MISSING_LIMIT": {
        "type": "PERFORMANCE",
        "description": "Add LIMIT clause to prevent unexpectedly large result sets",
        "impact": "low",
    },
}


def _safe_sql(node: exp.Expression, dialect: str) -> str:
    """Safely convert an AST node to SQL string."""
    try:
        return node.sql(dialect=dialect)
    except Exception:
        return str(node)


def _run_schema_optimize(ast: exp.Expression, dialect: str, schema_context: dict) -> exp.Expression | None:
    """Run the full sqlglot optimizer with schema context.

    Returns the optimized AST, or None if optimization fails.
    """
    try:
        return optimize(ast.copy(), schema=schema_context, dialect=dialect)
    except Exception:
        return None


def _run_schemaless_passes(ast: exp.Expression, dialect: str) -> exp.Expression:
    """Run individual optimizer passes that do not require schema context.

    Each pass is run independently; if any single pass fails, it is skipped.
    """
    result = ast.copy()

    # 1. Simplify: constant folding, boolean simplification (e.g. WHERE 1=1)
    try:
        result = simplify.simplify(result)
    except Exception:
        pass

    # 2. Eliminate unused CTEs
    try:
        result = eliminate_ctes.eliminate_ctes(result)
    except Exception:
        pass

    # 3. Normalize identifiers to consistent casing
    try:
        result = normalize_identifiers.normalize_identifiers(result, dialect=dialect)
    except Exception:
        pass

    # 4. Eliminate subqueries (convert to CTEs where beneficial)
    try:
        result = eliminate_subqueries.eliminate_subqueries(result)
    except Exception:
        pass

    # 5. Merge subqueries (inline simple subqueries)
    try:
        result = merge_subqueries.merge_subqueries(result)
    except Exception:
        pass

    return result


def _diff_suggestions(
    original_sql: str,
    optimized_sql: str,
    original_ast: exp.Expression,
    optimized_ast: exp.Expression,
    dialect: str,
) -> list[dict[str, Any]]:
    """Compare original and optimized ASTs to generate structural suggestions."""
    suggestions: list[dict[str, Any]] = []

    # Check if SELECT * was expanded to explicit columns
    original_stars = list(original_ast.find_all(exp.Star))
    optimized_stars = list(optimized_ast.find_all(exp.Star))
    if len(original_stars) > len(optimized_stars):
        suggestions.append({
            "type": "REWRITE",
            "description": "SELECT * expanded to explicit column list",
            "before": "SELECT *",
            "after": _extract_select_list(optimized_ast, dialect),
            "impact": "high",
        })

    # Check if boolean expressions were simplified (e.g. WHERE 1=1 removed)
    original_wheres = list(original_ast.find_all(exp.Where))
    optimized_wheres = list(optimized_ast.find_all(exp.Where))
    if len(original_wheres) > len(optimized_wheres):
        suggestions.append({
            "type": "REWRITE",
            "description": "Tautological WHERE clause removed (e.g. WHERE 1=1)",
            "before": _safe_sql(original_wheres[0], dialect) if original_wheres else None,
            "after": None,
            "impact": "low",
        })

    # Check if CTEs were eliminated
    original_ctes = list(original_ast.find_all(exp.CTE))
    optimized_ctes = list(optimized_ast.find_all(exp.CTE))
    if len(original_ctes) > len(optimized_ctes):
        removed_count = len(original_ctes) - len(optimized_ctes)
        removed_names = []
        optimized_cte_names = {c.alias for c in optimized_ctes}
        for cte in original_ctes:
            if cte.alias not in optimized_cte_names:
                removed_names.append(cte.alias)
        suggestions.append({
            "type": "STRUCTURE",
            "description": f"Removed {removed_count} unused CTE{'s' if removed_count > 1 else ''}: {', '.join(removed_names)}",
            "before": f"{removed_count} CTE definition{'s' if removed_count > 1 else ''}",
            "after": "Removed",
            "impact": "low",
        })

    # Check if subqueries were converted to CTEs
    original_subqueries = list(original_ast.find_all(exp.Subquery))
    optimized_subqueries = list(optimized_ast.find_all(exp.Subquery))
    if len(original_subqueries) > len(optimized_subqueries) and len(optimized_ctes) > len(original_ctes):
        suggestions.append({
            "type": "STRUCTURE",
            "description": "Subqueries extracted to CTEs for improved readability and potential reuse",
            "before": f"{len(original_subqueries)} inline subquer{'ies' if len(original_subqueries) > 1 else 'y'}",
            "after": f"{len(optimized_ctes)} CTE{'s' if len(optimized_ctes) > 1 else ''}",
            "impact": "medium",
        })

    return suggestions


def _extract_select_list(ast: exp.Expression, dialect: str) -> str | None:
    """Extract the SELECT column list from an AST as a string."""
    if isinstance(ast, exp.Select):
        expressions = ast.args.get("expressions")
        if expressions:
            cols = [_safe_sql(e, dialect) for e in expressions[:5]]
            suffix = ", ..." if len(expressions) > 5 else ""
            return f"SELECT {', '.join(cols)}{suffix}"
    return None


def _suggestions_from_anti_patterns(anti_patterns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Generate optimization suggestions from detected anti-patterns."""
    suggestions: list[dict[str, Any]] = []
    seen_types: set[str] = set()

    for pattern in anti_patterns:
        pattern_type = pattern.get("type", "")
        if pattern_type in seen_types:
            continue
        seen_types.add(pattern_type)

        template = _ANTI_PATTERN_SUGGESTIONS.get(pattern_type)
        if not template:
            continue

        suggestions.append({
            "type": template["type"],
            "description": template["description"],
            "before": pattern.get("location"),
            "after": None,
            "impact": template["impact"],
        })

    return suggestions


def optimize_sql(
    sql: str,
    dialect: str = "snowflake",
    schema_context: dict | None = None,
) -> dict[str, Any]:
    """Optimize a SQL query and return suggestions.

    Uses sqlglot's built-in optimizer passes and the static analyzer to identify
    optimization opportunities.

    Args:
        sql: The SQL query to optimize.
        dialect: The SQL dialect (default: snowflake).
        schema_context: Optional schema mapping for full optimization.
            Format: {"table_name": {"col_name": "TYPE", ...}, ...}

    Returns:
        Dictionary with optimization results including:
        - success: whether analysis completed
        - original_sql: the input SQL
        - optimized_sql: the rewritten SQL (if different)
        - suggestions: list of optimization suggestions
        - anti_patterns: raw anti-pattern findings
        - confidence: overall confidence level
        - error: error message if analysis failed
    """
    # Step 1: Parse the SQL
    try:
        ast = sqlglot.parse_one(sql, dialect=dialect)
    except Exception as e:
        return {
            "success": False,
            "original_sql": sql,
            "optimized_sql": None,
            "suggestions": [],
            "anti_patterns": [],
            "confidence": "low",
            "error": f"Failed to parse SQL: {e}",
        }

    # Step 2: Run the static analyzer to find anti-patterns
    analysis = analyze_sql(sql, dialect)
    anti_patterns = analysis.get("issues", [])

    # Step 3: Apply optimizer passes
    optimized_ast: exp.Expression | None = None

    if schema_context:
        optimized_ast = _run_schema_optimize(ast, dialect, schema_context)

    if optimized_ast is None:
        optimized_ast = _run_schemaless_passes(ast, dialect)

    # Step 4: Generate the optimized SQL string
    original_sql_normalized = _safe_sql(ast, dialect)
    optimized_sql_str = _safe_sql(optimized_ast, dialect)

    # Only report optimized SQL if it differs structurally from the original.
    # Case-insensitive comparison avoids reporting identifier normalization as a change.
    sql_changed = original_sql_normalized.upper() != optimized_sql_str.upper()
    final_optimized_sql = optimized_sql_str if sql_changed else None

    # Step 5: Generate suggestions
    suggestions: list[dict[str, Any]] = []

    # Suggestions from AST diff
    if sql_changed:
        suggestions.extend(_diff_suggestions(
            original_sql_normalized,
            optimized_sql_str,
            ast,
            optimized_ast,
            dialect,
        ))

    # Suggestions from anti-pattern analysis
    suggestions.extend(_suggestions_from_anti_patterns(anti_patterns))

    # Step 6: Determine overall confidence
    confidence = analysis.get("confidence", "high")

    return {
        "success": True,
        "original_sql": sql,
        "optimized_sql": final_optimized_sql,
        "suggestions": suggestions,
        "anti_patterns": anti_patterns,
        "confidence": confidence,
        "error": None,
    }
