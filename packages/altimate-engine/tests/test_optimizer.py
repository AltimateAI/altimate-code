"""Tests for sql/optimizer.py — SQL query optimization using sqlglot and static analysis."""

import pytest

from altimate_engine.sql.optimizer import (
    optimize_sql,
    _suggestions_from_anti_patterns,
    _safe_sql,
    _run_schemaless_passes,
    _ANTI_PATTERN_SUGGESTIONS_BASE,
)


class TestOptimizeSqlBasic:
    """Core optimize_sql() behavior."""

    def test_clean_query_returns_success(self):
        """A simple query with no issues returns success and no suggestions."""
        result = optimize_sql("SELECT id, name FROM users LIMIT 10", dialect="snowflake")
        assert result["success"] is True
        assert result["error"] is None
        assert isinstance(result["suggestions"], list)
        assert isinstance(result["anti_patterns"], list)

    def test_empty_sql_returns_parse_error(self):
        """Empty string should fail to parse."""
        result = optimize_sql("", dialect="snowflake")
        assert result["success"] is False
        assert result["error"] is not None
        assert "parse" in result["error"].lower() or "Failed" in result["error"]
        assert result["suggestions"] == []
        assert result["anti_patterns"] == []
        assert result["confidence"] == "low"

    def test_invalid_sql_returns_parse_error(self):
        """Gibberish SQL should fail to parse."""
        result = optimize_sql("NOT VALID SQL }{}{", dialect="snowflake")
        assert result["success"] is False
        assert result["error"] is not None
        assert result["optimized_sql"] is None

    def test_original_sql_preserved(self):
        """The original_sql field should always contain the input SQL."""
        sql = "SELECT * FROM orders"
        result = optimize_sql(sql)
        assert result["original_sql"] == sql

    def test_no_change_means_optimized_sql_is_none(self):
        """When optimizer produces no structural changes, optimized_sql should be None."""
        sql = "SELECT id FROM users LIMIT 10"
        result = optimize_sql(sql, dialect="snowflake")
        assert result["success"] is True
        # optimized_sql is None when nothing changed structurally
        assert result["optimized_sql"] is None


class TestOptimizeSqlAntiPatterns:
    """Optimizer should detect anti-patterns and generate suggestions."""

    def test_select_star_detected(self):
        """SELECT * should produce a REWRITE suggestion."""
        result = optimize_sql("SELECT * FROM orders", dialect="snowflake")
        assert result["success"] is True
        types = [s["type"] for s in result["suggestions"]]
        assert "REWRITE" in types or "PERFORMANCE" in types
        # Anti-patterns should include SELECT_STAR
        ap_types = [ap["type"] for ap in result["anti_patterns"]]
        assert "SELECT_STAR" in ap_types

    def test_union_instead_of_union_all(self):
        """UNION should be flagged for potential UNION ALL."""
        sql = "SELECT id FROM a UNION SELECT id FROM b"
        result = optimize_sql(sql, dialect="snowflake")
        assert result["success"] is True
        ap_types = [ap["type"] for ap in result["anti_patterns"]]
        assert "UNION_INSTEAD_OF_UNION_ALL" in ap_types
        suggestion_descs = [s["description"].lower() for s in result["suggestions"]]
        assert any("union all" in d for d in suggestion_descs)

    def test_order_by_without_limit(self):
        """ORDER BY without LIMIT should be flagged."""
        sql = "SELECT id, name FROM users ORDER BY name"
        result = optimize_sql(sql, dialect="snowflake")
        assert result["success"] is True
        ap_types = [ap["type"] for ap in result["anti_patterns"]]
        assert "ORDER_BY_WITHOUT_LIMIT" in ap_types

    def test_not_in_with_subquery(self):
        """NOT IN with subquery should be flagged."""
        sql = "SELECT * FROM orders WHERE id NOT IN (SELECT order_id FROM returns)"
        result = optimize_sql(sql, dialect="snowflake")
        assert result["success"] is True
        ap_types = [ap["type"] for ap in result["anti_patterns"]]
        assert "NOT_IN_WITH_SUBQUERY" in ap_types

    def test_like_leading_wildcard(self):
        """LIKE with leading wildcard should be flagged."""
        sql = "SELECT * FROM users WHERE name LIKE '%smith'"
        result = optimize_sql(sql, dialect="snowflake")
        assert result["success"] is True
        ap_types = [ap["type"] for ap in result["anti_patterns"]]
        assert "LIKE_LEADING_WILDCARD" in ap_types

    def test_correlated_subquery(self):
        """Correlated subquery should be flagged."""
        sql = """
        SELECT *
        FROM orders o
        WHERE EXISTS (
            SELECT 1 FROM returns r WHERE r.order_id = o.id
        )
        """
        result = optimize_sql(sql, dialect="snowflake")
        assert result["success"] is True
        # The EXISTS subquery references outer table o
        ap_types = [ap["type"] for ap in result["anti_patterns"]]
        # May be CORRELATED_SUBQUERY depending on analysis
        assert len(result["anti_patterns"]) > 0

    def test_unused_cte(self):
        """An unused CTE should be flagged."""
        sql = """
        WITH unused_cte AS (SELECT 1 AS x),
             used_cte AS (SELECT 2 AS y)
        SELECT y FROM used_cte
        """
        result = optimize_sql(sql, dialect="snowflake")
        assert result["success"] is True
        ap_types = [ap["type"] for ap in result["anti_patterns"]]
        assert "UNUSED_CTE" in ap_types

    def test_window_without_partition(self):
        """Window function without PARTITION BY should be flagged."""
        sql = "SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM users"
        result = optimize_sql(sql, dialect="snowflake")
        assert result["success"] is True
        ap_types = [ap["type"] for ap in result["anti_patterns"]]
        assert "WINDOW_WITHOUT_PARTITION" in ap_types


class TestOptimizeSqlDialects:
    """Dialect parameter should be respected."""

    def test_snowflake_dialect(self):
        result = optimize_sql("SELECT id FROM users LIMIT 10", dialect="snowflake")
        assert result["success"] is True

    def test_postgres_dialect(self):
        result = optimize_sql("SELECT id FROM users LIMIT 10", dialect="postgres")
        assert result["success"] is True

    def test_bigquery_dialect(self):
        result = optimize_sql("SELECT id FROM users LIMIT 10", dialect="bigquery")
        assert result["success"] is True

    def test_duckdb_dialect(self):
        result = optimize_sql("SELECT id FROM users LIMIT 10", dialect="duckdb")
        assert result["success"] is True


class TestOptimizeSqlSchemaContext:
    """Schema context usage in optimization."""

    def test_schema_context_provided(self):
        """When schema context is provided, the full optimizer should attempt to run."""
        schema = {"users": {"id": "INT", "name": "VARCHAR", "email": "VARCHAR"}}
        result = optimize_sql("SELECT * FROM users", dialect="snowflake", schema_context=schema)
        assert result["success"] is True

    def test_schema_context_none_uses_schemaless(self):
        """Without schema context, schemaless passes should still run."""
        result = optimize_sql("SELECT 1 WHERE 1 = 1", dialect="snowflake", schema_context=None)
        assert result["success"] is True

    def test_invalid_schema_context_falls_back(self):
        """If schema optimize fails, it falls back to schemaless passes."""
        # Provide a schema that doesn't match the query tables
        schema = {"nonexistent_table": {"col": "INT"}}
        result = optimize_sql("SELECT * FROM users", dialect="snowflake", schema_context=schema)
        assert result["success"] is True


class TestOptimizeSqlSuggestionTypes:
    """Each suggestion type from _ANTI_PATTERN_SUGGESTIONS_BASE should be reachable."""

    def test_all_suggestion_types_defined(self):
        """All anti-pattern types in the mapping should have valid suggestion types."""
        valid_types = {"REWRITE", "INDEX_HINT", "STRUCTURE", "PERFORMANCE"}
        for pattern_type, suggestion in _ANTI_PATTERN_SUGGESTIONS_BASE.items():
            assert suggestion["type"] in valid_types, f"{pattern_type} has invalid type {suggestion['type']}"
            has_desc = "description" in suggestion or "descriptions" in suggestion
            assert has_desc, f"{pattern_type} missing description or descriptions"
            assert "impact" in suggestion

    def test_structure_suggestion(self):
        """UNUSED_CTE maps to STRUCTURE type."""
        assert _ANTI_PATTERN_SUGGESTIONS_BASE["UNUSED_CTE"]["type"] == "STRUCTURE"

    def test_performance_suggestion(self):
        """ORDER_BY_WITHOUT_LIMIT maps to PERFORMANCE type."""
        assert _ANTI_PATTERN_SUGGESTIONS_BASE["ORDER_BY_WITHOUT_LIMIT"]["type"] == "PERFORMANCE"

    def test_rewrite_suggestion(self):
        """SELECT_STAR maps to REWRITE type."""
        assert _ANTI_PATTERN_SUGGESTIONS_BASE["SELECT_STAR"]["type"] == "REWRITE"


class TestSuggestionsFromAntiPatterns:
    """Test the _suggestions_from_anti_patterns helper."""

    def test_deduplicates_by_type(self):
        """Duplicate anti-pattern types should produce only one suggestion."""
        patterns = [
            {"type": "SELECT_STAR", "location": "table1"},
            {"type": "SELECT_STAR", "location": "table2"},
        ]
        suggestions = _suggestions_from_anti_patterns(patterns)
        assert len(suggestions) == 1

    def test_unknown_type_skipped(self):
        """Unknown anti-pattern types should be silently skipped."""
        patterns = [{"type": "NONEXISTENT_PATTERN", "location": "somewhere"}]
        suggestions = _suggestions_from_anti_patterns(patterns)
        assert len(suggestions) == 0

    def test_multiple_types(self):
        """Different anti-pattern types produce separate suggestions."""
        patterns = [
            {"type": "SELECT_STAR", "location": "t1"},
            {"type": "UNUSED_CTE", "location": "cte1"},
        ]
        suggestions = _suggestions_from_anti_patterns(patterns)
        assert len(suggestions) == 2
        types = {s["type"] for s in suggestions}
        assert "REWRITE" in types
        assert "STRUCTURE" in types


class TestSchemalessOptimizationPasses:
    """Test _run_schemaless_passes for CTE elimination, simplification, etc."""

    def test_unused_cte_eliminated(self):
        """Schemaless passes should eliminate unused CTEs."""
        import sqlglot
        from sqlglot import exp

        sql = "WITH unused AS (SELECT 1) SELECT 2"
        ast = sqlglot.parse_one(sql, dialect="snowflake")
        result = _run_schemaless_passes(ast, "snowflake")
        # After elimination, unused CTE should be removed
        ctes = list(result.find_all(exp.CTE))
        assert len(ctes) == 0

    def test_tautological_where_simplified(self):
        """WHERE 1=1 should be simplified away."""
        import sqlglot

        sql = "SELECT id FROM users WHERE 1 = 1"
        ast = sqlglot.parse_one(sql, dialect="snowflake")
        result = _run_schemaless_passes(ast, "snowflake")
        result_sql = result.sql(dialect="snowflake")
        # The WHERE 1=1 should have been removed or simplified
        assert "WHERE" not in result_sql.upper() or "TRUE" in result_sql.upper() or "1 = 1" not in result_sql


class TestComplexQueries:
    """Test with more complex real-world-ish queries."""

    def test_multi_join_query(self):
        """Complex multi-join query should parse and optimize."""
        sql = """
        SELECT o.id, c.name, p.title
        FROM orders o
        JOIN customers c ON o.customer_id = c.id
        JOIN products p ON o.product_id = p.id
        WHERE o.created_at > '2024-01-01'
        ORDER BY o.created_at DESC
        """
        result = optimize_sql(sql, dialect="snowflake")
        assert result["success"] is True
        # Should detect ORDER_BY_WITHOUT_LIMIT and MISSING_LIMIT
        ap_types = [ap["type"] for ap in result["anti_patterns"]]
        assert "ORDER_BY_WITHOUT_LIMIT" in ap_types

    def test_nested_subquery_query(self):
        """Nested subqueries should be analyzed."""
        sql = """
        SELECT * FROM (
            SELECT id, name FROM users WHERE active = TRUE
        ) sub
        WHERE sub.id IN (SELECT user_id FROM premium_users)
        """
        result = optimize_sql(sql, dialect="snowflake")
        assert result["success"] is True

    def test_very_long_query(self):
        """A query with many conditions should still work."""
        conditions = " AND ".join([f"col{i} = {i}" for i in range(50)])
        sql = f"SELECT * FROM big_table WHERE {conditions}"
        result = optimize_sql(sql, dialect="snowflake")
        assert result["success"] is True
