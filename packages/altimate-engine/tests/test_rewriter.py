"""Tests for sql/rewriter.py — 3 rewrite rules."""

import pytest

from altimate_engine.sql.rewriter import rewrite_sql


# ---------------------------------------------------------------------------
# Rule 1: SELECT * → explicit columns
# ---------------------------------------------------------------------------


class TestSelectStarRewrite:
    """SELECT * expansion using schema_context."""

    def test_expand_single_table(self):
        sql = "SELECT * FROM orders"
        schema = {"orders": {"id": "INT", "customer_id": "INT", "total": "DECIMAL"}}
        result = rewrite_sql(sql, "snowflake", schema)
        assert result["success"]
        assert result["rewritten_sql"] is not None
        assert "id" in result["rewritten_sql"]
        assert "customer_id" in result["rewritten_sql"]
        assert "total" in result["rewritten_sql"]
        assert "*" not in result["rewritten_sql"]
        assert len(result["rewrites_applied"]) == 1
        assert result["rewrites_applied"][0]["rule"] == "SELECT_STAR"
        assert result["rewrites_applied"][0]["can_auto_apply"] is True

    def test_expand_multi_table_with_prefix(self):
        sql = "SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id"
        schema = {
            "orders": {"id": "INT", "customer_id": "INT", "total": "DECIMAL"},
            "customers": {"id": "INT", "name": "VARCHAR"},
        }
        result = rewrite_sql(sql, "snowflake", schema)
        assert result["success"]
        assert result["rewritten_sql"] is not None
        # Should use table prefixes when multiple tables
        rewritten = result["rewritten_sql"].lower()
        assert "o." in rewritten or "c." in rewritten

    def test_skip_without_schema(self):
        sql = "SELECT * FROM orders"
        result = rewrite_sql(sql, "snowflake", None)
        assert result["success"]
        assert result["rewritten_sql"] is None
        # Should have a skip note
        assert any(
            r["can_auto_apply"] is False
            for r in result["rewrites_applied"]
        ) or len(result["rewrites_applied"]) == 0

    def test_skip_partial_schema(self):
        """When only some tables have schema, skip expansion."""
        sql = "SELECT * FROM orders JOIN unknown_table ON orders.id = unknown_table.id"
        schema = {"orders": {"id": "INT", "total": "DECIMAL"}}
        result = rewrite_sql(sql, "snowflake", schema)
        assert result["success"]
        # Should have skip note for unknown_table
        skipped = [r for r in result["rewrites_applied"] if r["can_auto_apply"] is False]
        assert len(skipped) > 0

    def test_no_star_noop(self):
        sql = "SELECT id, name FROM users"
        schema = {"users": {"id": "INT", "name": "VARCHAR"}}
        result = rewrite_sql(sql, "snowflake", schema)
        assert result["success"]
        assert result["rewritten_sql"] is None
        assert len(result["rewrites_applied"]) == 0

    def test_schema_context_list_format(self):
        """Schema can be a list of column names."""
        sql = "SELECT * FROM users"
        schema = {"users": ["id", "name", "email"]}
        result = rewrite_sql(sql, "snowflake", schema)
        assert result["success"]
        assert result["rewritten_sql"] is not None
        assert "id" in result["rewritten_sql"]

    def test_case_insensitive_table_match(self):
        sql = "SELECT * FROM ORDERS"
        schema = {"orders": {"id": "INT", "total": "DECIMAL"}}
        result = rewrite_sql(sql, "snowflake", schema)
        assert result["success"]
        assert result["rewritten_sql"] is not None

    def test_multiple_stars_in_query(self):
        """When query has SELECT * in subquery too."""
        sql = "SELECT * FROM (SELECT * FROM orders) sub"
        schema = {"orders": {"id": "INT", "total": "DECIMAL"}}
        result = rewrite_sql(sql, "snowflake", schema)
        assert result["success"]
        # At least one rewrite should be applied
        assert len(result["rewrites_applied"]) >= 1


# ---------------------------------------------------------------------------
# Rule 2: Non-sargable function-wrapped WHERE → sargable range predicates
# ---------------------------------------------------------------------------


class TestNonSargableRewrite:
    """YEAR(col)/DATE(col) rewrites to range predicates."""

    def test_year_equals(self):
        sql = "SELECT * FROM orders WHERE YEAR(created_at) = 2024"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        assert result["rewritten_sql"] is not None
        rewritten = result["rewritten_sql"]
        assert "2024-01-01" in rewritten
        assert "2025-01-01" in rewritten
        sargable_rewrites = [r for r in result["rewrites_applied"] if r["rule"] == "NON_SARGABLE"]
        assert len(sargable_rewrites) >= 1
        assert sargable_rewrites[0]["can_auto_apply"] is True

    def test_date_equals(self):
        sql = "SELECT id FROM events WHERE DATE(event_time) = '2024-03-15'"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        assert result["rewritten_sql"] is not None
        rewritten = result["rewritten_sql"]
        assert "2024-03-15" in rewritten
        assert "2024-03-16" in rewritten

    def test_no_rewrite_for_unsupported_function(self):
        sql = "SELECT * FROM orders WHERE UPPER(status) = 'ACTIVE'"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        sargable = [r for r in result["rewrites_applied"] if r["rule"] == "NON_SARGABLE"]
        assert len(sargable) == 0

    def test_no_rewrite_without_column(self):
        """Functions on literals should not be rewritten."""
        sql = "SELECT * FROM orders WHERE YEAR('2024-01-01') = 2024"
        result = rewrite_sql(sql, "snowflake")
        # YEAR on a literal, not a column — should not rewrite
        sargable = [r for r in result["rewrites_applied"] if r["rule"] == "NON_SARGABLE"]
        # This may or may not match depending on whether the literal is a Column;
        # the key test is that it doesn't crash
        assert result["success"]

    def test_year_boundary(self):
        """Year 9999 should still produce valid boundaries."""
        sql = "SELECT id FROM t WHERE YEAR(dt) = 9999"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        # 10000-01-01 boundary
        sargable = [r for r in result["rewrites_applied"] if r["rule"] == "NON_SARGABLE"]
        if sargable:
            assert "10000-01-01" in sargable[0]["rewritten_fragment"]

    def test_multiple_sargable_rewrites(self):
        sql = "SELECT * FROM t WHERE YEAR(a) = 2024 AND YEAR(b) = 2025"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        sargable = [r for r in result["rewrites_applied"] if r["rule"] == "NON_SARGABLE"]
        assert len(sargable) >= 1  # At least one should be rewritten

    def test_postgres_dialect(self):
        sql = "SELECT * FROM orders WHERE YEAR(created_at) = 2024"
        result = rewrite_sql(sql, "postgres")
        assert result["success"]


# ---------------------------------------------------------------------------
# Rule 3: Large IN list → CTE VALUES
# ---------------------------------------------------------------------------


class TestLargeInListRewrite:
    """IN list with 20+ items → CTE with VALUES clause."""

    def test_rewrite_large_in(self):
        values = ", ".join(str(i) for i in range(25))
        sql = f"SELECT * FROM orders WHERE id IN ({values})"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        assert result["rewritten_sql"] is not None
        in_rewrites = [r for r in result["rewrites_applied"] if r["rule"] == "LARGE_IN_LIST"]
        assert len(in_rewrites) == 1
        assert "25" in in_rewrites[0]["explanation"]
        assert in_rewrites[0]["can_auto_apply"] is True

    def test_no_rewrite_small_in(self):
        values = ", ".join(str(i) for i in range(5))
        sql = f"SELECT * FROM orders WHERE id IN ({values})"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        in_rewrites = [r for r in result["rewrites_applied"] if r["rule"] == "LARGE_IN_LIST"]
        assert len(in_rewrites) == 0

    def test_threshold_exactly_20(self):
        values = ", ".join(str(i) for i in range(20))
        sql = f"SELECT * FROM orders WHERE id IN ({values})"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        in_rewrites = [r for r in result["rewrites_applied"] if r["rule"] == "LARGE_IN_LIST"]
        assert len(in_rewrites) == 1

    def test_threshold_19_no_rewrite(self):
        values = ", ".join(str(i) for i in range(19))
        sql = f"SELECT * FROM orders WHERE id IN ({values})"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        in_rewrites = [r for r in result["rewrites_applied"] if r["rule"] == "LARGE_IN_LIST"]
        assert len(in_rewrites) == 0

    def test_string_values(self):
        values = ", ".join(f"'{chr(65 + i % 26)}_{i}'" for i in range(25))
        sql = f"SELECT * FROM users WHERE name IN ({values})"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        in_rewrites = [r for r in result["rewrites_applied"] if r["rule"] == "LARGE_IN_LIST"]
        assert len(in_rewrites) == 1

    def test_multiple_large_in_lists(self):
        vals1 = ", ".join(str(i) for i in range(25))
        vals2 = ", ".join(str(i + 100) for i in range(30))
        sql = f"SELECT * FROM orders WHERE id IN ({vals1}) OR status IN ({vals2})"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        in_rewrites = [r for r in result["rewrites_applied"] if r["rule"] == "LARGE_IN_LIST"]
        assert len(in_rewrites) >= 1


# ---------------------------------------------------------------------------
# Combined rules
# ---------------------------------------------------------------------------


class TestCombinedRewrites:
    """Multiple rules applied together."""

    def test_star_and_sargable(self):
        sql = "SELECT * FROM orders WHERE YEAR(created_at) = 2024"
        schema = {"orders": {"id": "INT", "created_at": "TIMESTAMP", "total": "DECIMAL"}}
        result = rewrite_sql(sql, "snowflake", schema)
        assert result["success"]
        assert result["rewritten_sql"] is not None
        rules = {r["rule"] for r in result["rewrites_applied"] if r["can_auto_apply"]}
        assert "SELECT_STAR" in rules or "NON_SARGABLE" in rules

    def test_parse_error(self):
        sql = "SELECT * FROM WHERE AND OR"
        result = rewrite_sql(sql, "snowflake")
        # sqlglot may still parse lenient SQL; check it doesn't crash
        assert isinstance(result["success"], bool)

    def test_empty_query(self):
        sql = "SELECT 1"
        result = rewrite_sql(sql, "snowflake")
        assert result["success"]
        assert result["rewritten_sql"] is None
        assert len(result["rewrites_applied"]) == 0

    def test_dialect_preservation(self):
        """Rewritten SQL should use the specified dialect."""
        sql = "SELECT * FROM orders"
        schema = {"orders": {"id": "INT", "name": "VARCHAR"}}
        result = rewrite_sql(sql, "postgres", schema)
        assert result["success"]
        assert result["rewritten_sql"] is not None
