"""Static SQL analysis for detecting anti-patterns and optimization opportunities."""

from __future__ import annotations

from typing import Any

import sqlglot
from sqlglot import exp


# ---------------------------------------------------------------------------
# Dialect-aware recommendation text
# ---------------------------------------------------------------------------

_RECOMMENDATIONS: dict[str, dict[str, str]] = {
    "select_star": {
        "snowflake": (
            "List columns explicitly — Snowflake's columnar storage only reads "
            "needed columns, reducing bytes scanned and cost."
        ),
        "postgres": (
            "List columns explicitly to avoid pulling unnecessary data over the "
            "network and to let the planner use index-only scans."
        ),
        "duckdb": (
            "List columns explicitly for clarity and to leverage DuckDB's "
            "columnar scan optimization."
        ),
        "_default": (
            "Consider selecting only the columns you need. In columnar databases, "
            "selecting specific columns significantly improves performance."
        ),
    },
    "function_in_join": {
        "snowflake": (
            "Functions on columns in JOIN conditions can prevent optimal join "
            "pruning in Snowflake. Review if this function is necessary for "
            "the join logic."
        ),
        "postgres": (
            "Functions on columns in JOIN conditions prevent PostgreSQL from "
            "using indexes. Consider creating an expression index, or apply "
            "the function to the comparison value instead."
        ),
        "duckdb": (
            "Functions on columns in JOIN conditions may prevent join "
            "optimization. Review if this function is necessary."
        ),
        "_default": (
            "Functions on columns in JOIN conditions may prevent index or "
            "partition pruning. Review if this function is necessary for "
            "the join logic."
        ),
    },
    "function_in_filter": {
        "snowflake": (
            "Functions on columns in WHERE clauses can prevent partition "
            "pruning in Snowflake. If possible, restructure the filter to "
            "apply the function to the comparison value instead of the column."
        ),
        "postgres": (
            "Functions on columns in WHERE clauses prevent PostgreSQL from "
            "using indexes. Create an expression index or restructure the "
            "filter to apply the function to the comparison value."
        ),
        "duckdb": (
            "Functions on columns in WHERE clauses may prevent filter "
            "push-down. If possible, restructure the filter to apply the "
            "function to the comparison value."
        ),
        "_default": (
            "Functions on columns in WHERE clauses may prevent index or "
            "partition pruning. If possible, restructure the filter to "
            "apply the function to the comparison value instead of the column."
        ),
    },
    "missing_limit": {
        "snowflake": (
            "Add a LIMIT clause to prevent scanning entire tables — "
            "Snowflake charges per byte scanned."
        ),
        "postgres": (
            "Add a LIMIT clause to prevent returning unbounded result sets "
            "that consume memory and network bandwidth."
        ),
        "duckdb": (
            "Add a LIMIT clause to cap result size, especially for ad-hoc queries."
        ),
        "_default": (
            "Consider adding a LIMIT clause to prevent unexpectedly large "
            "result sets, especially for ad-hoc queries."
        ),
    },
    "cartesian_product": {
        "snowflake": (
            "Verify this is intentional. CROSS JOINs multiply row counts "
            "and in Snowflake the resulting bytes scanned can be enormous."
        ),
        "postgres": (
            "Verify this is intentional. CROSS JOINs multiply row counts "
            "and can exhaust PostgreSQL's work_mem."
        ),
        "duckdb": (
            "Verify this is intentional. CROSS JOINs multiply row counts "
            "and can consume large amounts of memory."
        ),
        "_default": (
            "Verify this is intentional. CROSS JOINs multiply row counts "
            "and can cause performance issues with large tables."
        ),
    },
    "implicit_cartesian": {
        "_default": (
            "Add explicit JOIN conditions to relate the tables, "
            "or add a WHERE clause with join predicates."
        ),
    },
    "implicit_cartesian_multi": {
        "_default": "Add explicit JOIN conditions to relate the tables.",
    },
    "order_by_without_limit": {
        "snowflake": (
            "Sorting large result sets in Snowflake is expensive and consumes "
            "warehouse credits. Add a LIMIT clause if you only need top/bottom "
            "N rows, or remove ORDER BY if sorting is not required."
        ),
        "postgres": (
            "Sorting large result sets in PostgreSQL may spill to disk. "
            "Add a LIMIT clause if you only need top/bottom N rows, or "
            "remove ORDER BY if sorting is not required."
        ),
        "duckdb": (
            "Add a LIMIT clause if you only need top/bottom N rows, or "
            "remove ORDER BY if sorting is not required."
        ),
        "_default": (
            "Sorting the entire result set is expensive. Add a LIMIT clause "
            "if you only need top/bottom N rows, or remove ORDER BY if "
            "sorting is not required."
        ),
    },
    "like_leading_wildcard": {
        "snowflake": (
            "Leading wildcards (% or _) prevent the use of clustering keys "
            "for filtering. Consider Snowflake's SEARCH optimization or "
            "restructure the query."
        ),
        "postgres": (
            "Leading wildcards (% or _) prevent B-tree index usage. Consider "
            "a trigram (pg_trgm) index or full-text search for this pattern."
        ),
        "duckdb": (
            "Leading wildcards (% or _) force a full table scan. Consider "
            "restructuring the query if this is a performance bottleneck."
        ),
        "_default": (
            "Leading wildcards (% or _) prevent index or clustering key "
            "usage for filtering. Consider restructuring the query or "
            "using full-text search features."
        ),
    },
    "large_in_list": {
        "snowflake": (
            "Large IN lists cause query compilation overhead in Snowflake. "
            "Consider using a CTE with VALUES clause or a temporary table."
        ),
        "postgres": (
            "Large IN lists can slow down PostgreSQL's query planner. "
            "Consider using a CTE with VALUES clause, or a temporary table "
            "with an = ANY(array) pattern."
        ),
        "duckdb": (
            "Large IN lists may slow query compilation. Consider using a "
            "CTE with VALUES clause instead."
        ),
        "_default": (
            "Large IN lists can cause query compilation overhead. Consider "
            "using a CTE with VALUES clause or a temporary table instead."
        ),
    },
    "or_in_join": {
        "snowflake": (
            "OR conditions in JOIN ON clauses prevent Snowflake's join "
            "optimization and increase bytes scanned. Consider splitting "
            "into separate JOINs with UNION ALL."
        ),
        "postgres": (
            "OR conditions in JOIN ON clauses prevent the PostgreSQL planner "
            "from using hash or merge joins. Consider splitting into separate "
            "JOINs with UNION ALL."
        ),
        "duckdb": (
            "OR conditions in JOIN ON clauses may prevent join optimization. "
            "Consider splitting into separate JOINs with UNION ALL."
        ),
        "_default": (
            "Consider splitting into separate JOINs with UNION ALL, or "
            "restructuring the join condition for better optimization."
        ),
    },
}


def _recommend(concept: str, dialect: str | None) -> str:
    """Return dialect-appropriate recommendation text."""
    d = (dialect or "").lower()
    rec = _RECOMMENDATIONS.get(concept, {})
    return rec.get(d, rec.get("_default", concept))


class StaticQueryAnalyzer:
    """Analyzes SQL queries statically using sqlglot to identify potential issues."""

    def __init__(self, sql: str, dialect: str = "snowflake"):
        """Initialize the analyzer with a SQL query.

        Args:
            sql: The SQL query to analyze
            dialect: The SQL dialect (default: snowflake)
        """
        self.sql = sql
        self.dialect = dialect
        self.ast = None
        self.parse_error = None

        try:
            self.ast = sqlglot.parse_one(sql, dialect=dialect)
        except Exception as e:
            self.parse_error = str(e)

    def analyze(self) -> dict[str, Any]:
        """Run all static analysis checks and return findings.

        Returns:
            Dictionary containing analysis results with issues found
        """
        if self.parse_error:
            return {
                "success": False,
                "error": f"Failed to parse SQL: {self.parse_error}",
                "issues": [],
                "issue_count": 0,
                "confidence": "low",
                "confidence_factors": ["SQL parse failed — results may be incomplete"],
            }

        issues = []

        issues.extend(self._check_select_star())
        issues.extend(self._check_function_in_join())
        issues.extend(self._check_function_in_filter())
        issues.extend(self._check_missing_limit())
        issues.extend(self._check_cartesian_product())
        issues.extend(self._check_order_by_without_limit())
        issues.extend(self._check_union_instead_of_union_all())
        issues.extend(self._check_not_in_with_subquery())
        issues.extend(self._check_like_leading_wildcard())
        issues.extend(self._check_large_in_list())
        issues.extend(self._check_correlated_subquery())
        issues.extend(self._check_unused_cte())
        issues.extend(self._check_select_star_in_subquery())
        issues.extend(self._check_or_in_join())
        issues.extend(self._check_non_equi_join())
        issues.extend(self._check_window_without_partition())
        issues.extend(self._check_group_by_primary_key())
        issues.extend(self._check_order_by_in_subquery())

        # Compute overall confidence using AST-based ConfidenceTracker
        from altimate_engine.sql.confidence import ConfidenceTracker

        tracker = ConfidenceTracker(self.ast, self.dialect)
        overall_confidence, confidence_factors = tracker.evaluate()

        # Also consider per-issue confidence
        issue_confidences = [issue.get("confidence", "high") for issue in issues]
        if "low" in issue_confidences and overall_confidence != "low":
            overall_confidence = "low"
            confidence_factors.append("Individual issue has low confidence")
        elif "medium" in issue_confidences and overall_confidence == "high":
            overall_confidence = "medium"
            confidence_factors.append("Individual issue has medium confidence")

        return {
            "success": True,
            "query": self.sql,
            "dialect": self.dialect,
            "issues": issues,
            "issue_count": len(issues),
            "confidence": overall_confidence,
            "confidence_factors": confidence_factors,
        }

    def _check_select_star(self) -> list[dict]:
        """Check for SELECT * usage."""
        issues = []

        for star in self.ast.find_all(exp.Star):
            parent_select = star.find_ancestor(exp.Select)
            if parent_select:
                issues.append(
                    {
                        "type": "SELECT_STAR",
                        "severity": "warning",
                        "message": "Query uses SELECT * which can lead to unnecessary data transfer",
                        "recommendation": _recommend("select_star", self.dialect),
                        "location": self._get_location(star),
                        "confidence": "high",
                    }
                )

        return issues

    def _check_function_in_join(self) -> list[dict]:
        """Check for function usage in JOIN conditions."""
        issues = []

        for join in self.ast.find_all(exp.Join):
            on_clause = join.args.get("on")
            if on_clause:
                for func in on_clause.find_all(exp.Func):
                    if not isinstance(func, exp.AggFunc):
                        has_column = any(
                            isinstance(arg, exp.Column)
                            for arg in func.flatten()
                            if isinstance(arg, exp.Expression)
                        )
                        if has_column:
                            issues.append(
                                {
                                    "type": "FUNCTION_IN_JOIN",
                                    "severity": "warning",
                                    "message": f"Function '{func.sql()}' used in JOIN condition may prevent index usage",
                                    "recommendation": _recommend("function_in_join", self.dialect),
                                    "location": self._get_location(func),
                                    "confidence": "medium",
                                }
                            )

        return issues

    def _check_function_in_filter(self) -> list[dict]:
        """Check for function usage in WHERE/HAVING conditions."""
        issues = []

        for where in self.ast.find_all(exp.Where):
            for func in where.find_all(exp.Func):
                if not isinstance(func, exp.AggFunc):
                    has_column = any(
                        isinstance(arg, exp.Column)
                        for arg in func.flatten()
                        if isinstance(arg, exp.Expression)
                    )
                    if has_column:
                        issues.append(
                            {
                                "type": "FUNCTION_IN_FILTER",
                                "severity": "warning",
                                "message": f"Function '{func.sql()}' on column in WHERE clause may prevent optimal filtering",
                                "recommendation": _recommend("function_in_filter", self.dialect),
                                "location": self._get_location(func),
                                "confidence": "medium",
                            }
                        )

        return issues

    def _check_missing_limit(self) -> list[dict]:
        """Check for SELECT queries without LIMIT clause.

        Skips DML/DDL statements (CREATE TABLE AS SELECT, INSERT INTO SELECT, MERGE).
        """
        issues = []

        # Skip non-SELECT top-level statements (DML/DDL)
        if not isinstance(self.ast, exp.Select):
            return issues

        # Skip if this SELECT is wrapped in a DML context (e.g. CREATE TABLE AS, INSERT INTO)
        parent = self.ast.parent
        if parent and isinstance(parent, (exp.Create, exp.Insert, exp.Merge)):
            return issues

        has_limit = self.ast.args.get("limit") is not None
        has_offset = self.ast.args.get("offset") is not None
        has_aggregation = any(
            isinstance(expr, exp.AggFunc)
            for expr in self.ast.find_all(exp.Expression)
        )
        has_group_by = self.ast.args.get("group") is not None

        if not has_limit and not has_aggregation and not has_group_by:
            issues.append(
                {
                    "type": "MISSING_LIMIT",
                    "severity": "info",
                    "message": "SELECT query without LIMIT clause may return large result sets",
                    "recommendation": _recommend("missing_limit", self.dialect),
                    "location": None,
                    "confidence": "high",
                }
            )

        if has_offset and not has_limit:
            issues.append(
                {
                    "type": "OFFSET_WITHOUT_LIMIT",
                    "severity": "warning",
                    "message": "OFFSET without LIMIT will skip rows but still return all remaining rows",
                    "recommendation": "Add a LIMIT clause when using OFFSET to bound the result set",
                    "location": None,
                    "confidence": "high",
                }
            )

        return issues

    def _check_cartesian_product(self) -> list[dict]:
        """Check for potential Cartesian products (cross joins without conditions)."""
        issues = []

        for join in self.ast.find_all(exp.Join):
            if join.kind == "CROSS":
                issues.append(
                    {
                        "type": "CARTESIAN_PRODUCT",
                        "severity": "error",
                        "message": "CROSS JOIN detected which creates a Cartesian product",
                        "recommendation": _recommend("cartesian_product", self.dialect),
                        "location": self._get_location(join),
                        "confidence": "high",
                    }
                )
            # sqlglot parses "FROM a, b" as a Join with kind="," and no ON clause
            elif join.kind == "," or (not join.kind and not join.args.get("on")):
                where = self.ast.args.get("where") if isinstance(self.ast, exp.Select) else None
                if not where:
                    issues.append(
                        {
                            "type": "IMPLICIT_CARTESIAN",
                            "severity": "error",
                            "message": "Implicit comma join without WHERE condition creates a Cartesian product",
                            "recommendation": _recommend("implicit_cartesian", self.dialect),
                            "location": self._get_location(join),
                            "confidence": "high",
                        }
                    )

        if isinstance(self.ast, exp.Select):
            from_clause = self.ast.find(exp.From)
            if from_clause and from_clause.parent is self.ast:
                tables_in_from = list(from_clause.find_all(exp.Table))
                joins = list(self.ast.find_all(exp.Join))

                if len(tables_in_from) > 1 and len(joins) == 0:
                    where = self.ast.find(exp.Where)
                    if not where or where.parent is not self.ast:
                        issues.append(
                            {
                                "type": "IMPLICIT_CARTESIAN",
                                "severity": "error",
                                "message": "Multiple tables without JOIN or WHERE condition may create Cartesian product",
                                "recommendation": _recommend("implicit_cartesian_multi", self.dialect),
                                "location": None,
                                "confidence": "high",
                            }
                        )

        return issues

    def _check_order_by_without_limit(self) -> list[dict]:
        """Check for ORDER BY without LIMIT clause."""
        issues = []

        if isinstance(self.ast, exp.Select):
            has_order_by = self.ast.args.get("order") is not None
            has_limit = self.ast.args.get("limit") is not None
            has_aggregation = any(
                isinstance(expr, exp.AggFunc)
                for expr in self.ast.find_all(exp.Expression)
            )

            if has_order_by and not has_limit and not has_aggregation:
                issues.append(
                    {
                        "type": "ORDER_BY_WITHOUT_LIMIT",
                        "severity": "warning",
                        "message": "ORDER BY without LIMIT sorts the entire result set",
                        "recommendation": _recommend("order_by_without_limit", self.dialect),
                        "location": None,
                        "confidence": "high",
                    }
                )

        return issues

    def _check_union_instead_of_union_all(self) -> list[dict]:
        """Check for UNION that could be UNION ALL."""
        issues = []

        for union in self.ast.find_all(exp.Union):
            if union.args.get("distinct") is not False:
                issues.append(
                    {
                        "type": "UNION_INSTEAD_OF_UNION_ALL",
                        "severity": "warning",
                        "message": "UNION performs duplicate elimination which requires sorting",
                        "recommendation": "If duplicates between the result sets are unlikely or acceptable, "
                        "use UNION ALL instead. UNION ALL is significantly faster as it skips the deduplication step.",
                        "location": self._get_location(union),
                        "confidence": "high",
                    }
                )

        return issues

    def _check_not_in_with_subquery(self) -> list[dict]:
        """Check for NOT IN with subquery which can have NULL issues and poor performance."""
        issues = []

        for not_node in self.ast.find_all(exp.Not):
            for in_node in not_node.find_all(exp.In):
                query = in_node.args.get("query")
                if query:
                    issues.append(
                        {
                            "type": "NOT_IN_WITH_SUBQUERY",
                            "severity": "warning",
                            "message": "NOT IN with subquery can cause unexpected results with NULL values",
                            "recommendation": "If the subquery column can contain NULLs, NOT IN returns no rows. "
                            "Consider using NOT EXISTS or LEFT JOIN with IS NULL instead, which handles NULLs correctly "
                            "and often performs better.",
                            "location": self._get_location(in_node),
                            "confidence": "high",
                        }
                    )

        for neq in self.ast.find_all(exp.NEQ):
            all_node = neq.args.get("expression")
            if isinstance(all_node, exp.All):
                subquery = all_node.args.get("this")
                if isinstance(subquery, exp.Select):
                    issues.append(
                        {
                            "type": "NOT_IN_WITH_SUBQUERY",
                            "severity": "warning",
                            "message": "NOT IN with subquery can cause unexpected results with NULL values",
                            "recommendation": "If the subquery column can contain NULLs, NOT IN returns no rows. "
                            "Consider using NOT EXISTS or LEFT JOIN with IS NULL instead.",
                            "location": self._get_location(neq),
                            "confidence": "high",
                        }
                    )

        return issues

    def _check_like_leading_wildcard(self) -> list[dict]:
        """Check for LIKE patterns with leading wildcards."""
        issues = []

        for like in self.ast.find_all(exp.Like):
            pattern = like.args.get("expression")
            if pattern and isinstance(pattern, exp.Literal):
                pattern_str = str(pattern.this)
                if pattern_str.startswith("%") or pattern_str.startswith("_"):
                    issues.append(
                        {
                            "type": "LIKE_LEADING_WILDCARD",
                            "severity": "info",
                            "message": f"LIKE pattern '{pattern_str}' starts with wildcard",
                            "recommendation": _recommend("like_leading_wildcard", self.dialect),
                            "location": self._get_location(like),
                            "confidence": "high",
                        }
                    )

        return issues

    def _check_large_in_list(self) -> list[dict]:
        """Check for large IN lists that should use a temp table or CTE."""
        issues = []
        LARGE_IN_THRESHOLD = 50

        for in_node in self.ast.find_all(exp.In):
            expressions = in_node.args.get("expressions")
            if expressions and len(expressions) > LARGE_IN_THRESHOLD:
                issues.append(
                    {
                        "type": "LARGE_IN_LIST",
                        "severity": "warning",
                        "message": f"IN clause contains {len(expressions)} values",
                        "recommendation": _recommend("large_in_list", self.dialect),
                        "location": None,
                        "confidence": "high",
                    }
                )

        return issues

    def _check_correlated_subquery(self) -> list[dict]:
        """Check for correlated subqueries (N+1 pattern)."""
        issues = []
        for select in self.ast.find_all(exp.Select):
            # Skip SELECT inside CTE definitions — CTE references are not N+1
            if select.find_ancestor(exp.CTE):
                continue
            parent_select = select.find_ancestor(exp.Select)
            if parent_select is None:
                continue
            # Must be in a subquery-like context (Subquery, Exists, In)
            if not (select.find_ancestor(exp.Subquery) or select.find_ancestor(exp.Exists) or select.find_ancestor(exp.In)):
                continue
            # Collect only the direct tables of the parent (not from CTEs or other subqueries)
            outer_tables: set[str] = set()
            from_clause = parent_select.find(exp.From)
            if from_clause and from_clause.parent is parent_select:
                for t in from_clause.find_all(exp.Table):
                    outer_tables.add(t.alias_or_name)
            for join in parent_select.find_all(exp.Join):
                # Only direct joins, not those in nested subqueries
                if join.find_ancestor(exp.Subquery):
                    continue
                for t in join.find_all(exp.Table):
                    outer_tables.add(t.alias_or_name)
            for col in select.find_all(exp.Column):
                if col.table and col.table in outer_tables:
                    issues.append({
                        "type": "CORRELATED_SUBQUERY",
                        "severity": "warning",
                        "message": f"Correlated subquery references outer table '{col.table}' — may cause N+1 execution pattern",
                        "recommendation": "Consider rewriting as a JOIN or using a CTE to avoid repeated execution per row.",
                        "location": self._get_location(select),
                        "confidence": "medium",
                    })
                    break  # One issue per subquery
        return issues

    def _check_unused_cte(self) -> list[dict]:
        """Check for unused CTEs."""
        issues = []
        for cte in self.ast.find_all(exp.CTE):
            cte_name = cte.alias
            if not cte_name:
                continue
            # Check if the CTE name is referenced anywhere in the main query
            main_query = self.ast
            # Look for table references matching this CTE name outside the CTE itself
            referenced = False
            for table in main_query.find_all(exp.Table):
                if table.name == cte_name and not table.find_ancestor(exp.CTE):
                    referenced = True
                    break
            # Also check if referenced in other CTEs
            if not referenced:
                for other_cte in main_query.find_all(exp.CTE):
                    if other_cte.alias != cte_name:
                        for table in other_cte.find_all(exp.Table):
                            if table.name == cte_name:
                                referenced = True
                                break
                    if referenced:
                        break
            if not referenced:
                issues.append({
                    "type": "UNUSED_CTE",
                    "severity": "info",
                    "message": f"CTE '{cte_name}' is defined but never referenced",
                    "recommendation": "Remove unused CTEs to simplify the query and improve readability.",
                    "location": None,
                    "confidence": "high",
                })
        return issues

    def _check_select_star_in_subquery(self) -> list[dict]:
        """Check for SELECT * in subqueries."""
        issues = []
        for select in self.ast.find_all(exp.Select):
            # Only check subqueries, not the top-level SELECT
            if select.find_ancestor(exp.Subquery) or select.find_ancestor(exp.In):
                for star in select.find_all(exp.Star):
                    if star.find_ancestor(exp.Select) == select:
                        issues.append({
                            "type": "SELECT_STAR_IN_SUBQUERY",
                            "severity": "warning",
                            "message": "SELECT * in subquery transfers unnecessary data",
                            "recommendation": "Select only the columns needed by the outer query to reduce data movement.",
                            "location": self._get_location(select),
                            "confidence": "high",
                        })
                        break
        return issues

    def _check_or_in_join(self) -> list[dict]:
        """Check for OR conditions in JOIN ON clause."""
        issues = []
        for join in self.ast.find_all(exp.Join):
            on_clause = join.args.get("on")
            if on_clause:
                for or_node in on_clause.find_all(exp.Or):
                    issues.append({
                        "type": "OR_IN_JOIN",
                        "severity": "warning",
                        "message": "OR condition in JOIN ON clause may prevent join optimization",
                        "recommendation": _recommend("or_in_join", self.dialect),
                        "location": self._get_location(or_node),
                        "confidence": "medium",
                    })
                    break  # One per JOIN
        return issues

    def _check_non_equi_join(self) -> list[dict]:
        """Check for non-equi join conditions (cartesian risk)."""
        issues = []
        for join in self.ast.find_all(exp.Join):
            if join.kind == "CROSS":
                continue  # Already caught by cartesian check
            on_clause = join.args.get("on")
            if on_clause:
                has_eq = bool(list(on_clause.find_all(exp.EQ)))
                has_neq = bool(list(on_clause.find_all((exp.GT, exp.GTE, exp.LT, exp.LTE, exp.NEQ))))
                if has_neq and not has_eq:
                    issues.append({
                        "type": "NON_EQUI_JOIN",
                        "severity": "warning",
                        "message": "Non-equi join (inequality-only condition) may produce large intermediate results",
                        "recommendation": "Non-equi joins can behave like partial cartesian products. Ensure this is intentional and consider adding an equality condition.",
                        "location": self._get_location(join),
                        "confidence": "medium",
                    })
        return issues

    def _check_window_without_partition(self) -> list[dict]:
        """Check for window functions without PARTITION BY."""
        issues = []
        for window in self.ast.find_all(exp.Window):
            partition_by = window.args.get("partition_by")
            if not partition_by:
                func = window.this
                func_name = func.sql(dialect=self.dialect) if func else "unknown"
                issues.append({
                    "type": "WINDOW_WITHOUT_PARTITION",
                    "severity": "info",
                    "message": f"Window function '{func_name}' without PARTITION BY operates over entire result set",
                    "recommendation": "Consider adding a PARTITION BY clause to limit the window scope. Without it, the function processes all rows as a single partition.",
                    "location": self._get_location(window),
                    "confidence": "high",
                })
        return issues

    def _check_group_by_primary_key(self) -> list[dict]:
        """Check for GROUP BY on likely primary key columns."""
        issues = []
        if not isinstance(self.ast, exp.Select):
            return issues
        group = self.ast.args.get("group")
        if not group:
            return issues
        for expr in group.expressions:
            if isinstance(expr, exp.Column):
                col_name = expr.name.lower()
                if col_name == "id" or col_name.endswith("_id"):
                    issues.append({
                        "type": "GROUP_BY_PRIMARY_KEY",
                        "severity": "info",
                        "message": f"GROUP BY on '{expr.name}' which appears to be a primary/foreign key",
                        "recommendation": "Grouping by a unique key column produces one group per row, making the GROUP BY redundant. Verify this is the intended behavior.",
                        "location": self._get_location(expr),
                        "confidence": "medium",
                    })
        return issues

    def _check_order_by_in_subquery(self) -> list[dict]:
        """Check for ORDER BY in subquery without LIMIT."""
        issues = []
        for select in self.ast.find_all(exp.Select):
            if select.find_ancestor(exp.Subquery):
                has_order = select.args.get("order") is not None
                has_limit = select.args.get("limit") is not None
                if has_order and not has_limit:
                    issues.append({
                        "type": "ORDER_BY_IN_SUBQUERY",
                        "severity": "warning",
                        "message": "ORDER BY in subquery without LIMIT has no effect and adds sorting overhead",
                        "recommendation": "Remove the ORDER BY from the subquery or add a LIMIT clause if ordering is needed.",
                        "location": self._get_location(select),
                        "confidence": "high",
                    })
        return issues

    def _get_location(self, node: exp.Expression) -> str | None:
        """Get a string representation of the node's location in the query."""
        try:
            return node.sql(dialect=self.dialect)
        except Exception:
            return None


def analyze_sql(sql: str, dialect: str = "snowflake") -> dict[str, Any]:
    """Analyze a SQL query statically for potential issues.

    This function performs pre-execution analysis without running the query,
    identifying common anti-patterns and optimization opportunities.

    Args:
        sql: The SQL query to analyze
        dialect: The SQL dialect (default: snowflake)

    Returns:
        Dictionary containing analysis results
    """
    analyzer = StaticQueryAnalyzer(sql, dialect)
    return analyzer.analyze()
