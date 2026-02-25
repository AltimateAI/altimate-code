"""Confidence tracking for SQL analysis based on AST pattern detection."""

from __future__ import annotations

from sqlglot import exp


class ConfidenceTracker:
    """Evaluates SQL AST patterns to determine analysis confidence level.

    Runs 7 detection rules against the AST and degrades confidence
    based on patterns found. Confidence degrades to the worst level
    detected across all rules.
    """

    def __init__(self, ast: exp.Expression, dialect: str = "snowflake"):
        self.ast = ast
        self.dialect = dialect

    def evaluate(self) -> tuple[str, list[str]]:
        """Returns (confidence_level, list_of_factors).

        confidence_level is one of: "high", "medium", "low"
        """
        factors: list[str] = []

        # Low-confidence patterns
        if self._has_like_leading_wildcard():
            factors.append("LIKE patterns have 26% selectivity accuracy")

        if self._has_exists_subquery():
            factors.append("EXISTS subqueries cannot estimate cardinality")

        if self._has_correlated_subquery():
            factors.append("N+1 patterns unquantifiable statically")

        # Medium-confidence patterns
        if self._has_multi_table_joins():
            factors.append("Multi-table joins compound estimation error")

        if self._has_select_star_in_subquery():
            factors.append("Prevents column-level analysis")

        if self._has_or_in_join():
            factors.append("Complicates cardinality estimation")

        if self._has_non_equi_join():
            factors.append("High cardinality variance")

        # Determine overall level from worst detected
        low_factors = {
            "LIKE patterns have 26% selectivity accuracy",
            "EXISTS subqueries cannot estimate cardinality",
            "N+1 patterns unquantifiable statically",
        }
        has_low = any(f in low_factors for f in factors)
        has_medium = any(f not in low_factors for f in factors)

        if has_low:
            level = "low"
        elif has_medium:
            level = "medium"
        else:
            level = "high"

        return level, factors

    def _has_like_leading_wildcard(self) -> bool:
        """Rule 1: LIKE with leading wildcard."""
        for like in self.ast.find_all(exp.Like):
            pattern = like.args.get("expression")
            if pattern and isinstance(pattern, exp.Literal):
                pattern_str = str(pattern.this)
                if pattern_str.startswith("%") or pattern_str.startswith("_"):
                    return True
        return False

    def _has_exists_subquery(self) -> bool:
        """Rule 2: EXISTS subquery."""
        return bool(list(self.ast.find_all(exp.Exists)))

    def _has_correlated_subquery(self) -> bool:
        """Rule 3: Correlated subquery (N+1 pattern)."""
        for select in self.ast.find_all(exp.Select):
            parent_select = select.find_ancestor(exp.Select)
            if parent_select is None:
                continue
            outer_tables = {t.alias_or_name for t in parent_select.find_all(exp.Table)}
            for col in select.find_all(exp.Column):
                if col.table and col.table in outer_tables:
                    return True
        return False

    def _has_multi_table_joins(self) -> bool:
        """Rule 4: 3+ table joins."""
        joins = list(self.ast.find_all(exp.Join))
        return len(joins) >= 2  # FROM table + 2 JOINs = 3 tables

    def _has_select_star_in_subquery(self) -> bool:
        """Rule 5: SELECT * in subquery."""
        for select in self.ast.find_all(exp.Select):
            if select.find_ancestor(exp.Subquery) or select.find_ancestor(exp.In):
                for star in select.find_all(exp.Star):
                    if star.find_ancestor(exp.Select) == select:
                        return True
        return False

    def _has_or_in_join(self) -> bool:
        """Rule 6: OR in JOIN ON clause."""
        for join in self.ast.find_all(exp.Join):
            on_clause = join.args.get("on")
            if on_clause and list(on_clause.find_all(exp.Or)):
                return True
        return False

    def _has_non_equi_join(self) -> bool:
        """Rule 7: Non-equi join (inequality-only condition)."""
        for join in self.ast.find_all(exp.Join):
            if join.kind == "CROSS":
                continue
            on_clause = join.args.get("on")
            if on_clause:
                has_eq = bool(list(on_clause.find_all(exp.EQ)))
                has_neq = bool(
                    list(
                        on_clause.find_all(
                            (exp.GT, exp.GTE, exp.LT, exp.LTE, exp.NEQ)
                        )
                    )
                )
                if has_neq and not has_eq:
                    return True
        return False
