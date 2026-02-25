"""Tests for the static SQL analyzer."""

import pytest
from altimate_engine.sql.analyzer import analyze_sql, StaticQueryAnalyzer


class TestSelectStar:
    def test_detects_select_star(self):
        result = analyze_sql("SELECT * FROM orders")
        types = [i["type"] for i in result["issues"]]
        assert "SELECT_STAR" in types

    def test_no_issue_for_explicit_columns(self):
        result = analyze_sql("SELECT id, name FROM orders")
        types = [i["type"] for i in result["issues"]]
        assert "SELECT_STAR" not in types


class TestMissingLimit:
    def test_detects_missing_limit(self):
        result = analyze_sql("SELECT id FROM orders")
        types = [i["type"] for i in result["issues"]]
        assert "MISSING_LIMIT" in types

    def test_no_issue_with_limit(self):
        result = analyze_sql("SELECT id FROM orders LIMIT 10")
        types = [i["type"] for i in result["issues"]]
        assert "MISSING_LIMIT" not in types

    def test_no_issue_with_aggregation(self):
        result = analyze_sql("SELECT COUNT(*) FROM orders")
        types = [i["type"] for i in result["issues"]]
        assert "MISSING_LIMIT" not in types

    def test_no_issue_with_group_by(self):
        result = analyze_sql("SELECT status, COUNT(*) FROM orders GROUP BY status")
        types = [i["type"] for i in result["issues"]]
        assert "MISSING_LIMIT" not in types

    def test_no_false_positive_on_ctas(self):
        """MISSING_LIMIT should not fire on CREATE TABLE AS SELECT."""
        result = analyze_sql("CREATE TABLE new_orders AS SELECT id FROM orders", dialect="snowflake")
        types = [i["type"] for i in result["issues"]]
        assert "MISSING_LIMIT" not in types

    def test_no_false_positive_on_insert_into_select(self):
        """MISSING_LIMIT should not fire on INSERT INTO ... SELECT."""
        result = analyze_sql("INSERT INTO archive SELECT id FROM orders", dialect="snowflake")
        types = [i["type"] for i in result["issues"]]
        assert "MISSING_LIMIT" not in types


class TestUnionCheck:
    def test_detects_union_without_all(self):
        result = analyze_sql("SELECT id FROM a UNION SELECT id FROM b")
        types = [i["type"] for i in result["issues"]]
        assert "UNION_INSTEAD_OF_UNION_ALL" in types

    def test_no_issue_for_union_all(self):
        result = analyze_sql("SELECT id FROM a UNION ALL SELECT id FROM b")
        types = [i["type"] for i in result["issues"]]
        assert "UNION_INSTEAD_OF_UNION_ALL" not in types


class TestCartesianProduct:
    def test_detects_cross_join(self):
        result = analyze_sql("SELECT * FROM a CROSS JOIN b")
        types = [i["type"] for i in result["issues"]]
        assert "CARTESIAN_PRODUCT" in types


class TestCorrelatedSubquery:
    def test_detects_correlated_subquery(self):
        result = analyze_sql(
            "SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM items i WHERE i.order_id = o.id)"
        )
        types = [i["type"] for i in result["issues"]]
        assert "CORRELATED_SUBQUERY" in types


class TestNotInWithSubquery:
    def test_detects_not_in_with_subquery(self):
        result = analyze_sql(
            "SELECT * FROM orders WHERE id NOT IN (SELECT order_id FROM returns)"
        )
        types = [i["type"] for i in result["issues"]]
        assert "NOT_IN_WITH_SUBQUERY" in types


class TestLikeLeadingWildcard:
    def test_detects_leading_wildcard(self):
        result = analyze_sql("SELECT * FROM users WHERE name LIKE '%smith'")
        types = [i["type"] for i in result["issues"]]
        assert "LIKE_LEADING_WILDCARD" in types

    def test_no_issue_for_trailing_wildcard(self):
        result = analyze_sql("SELECT * FROM users WHERE name LIKE 'smith%'")
        types = [i["type"] for i in result["issues"]]
        assert "LIKE_LEADING_WILDCARD" not in types


class TestUnusedCte:
    def test_detects_unused_cte(self):
        result = analyze_sql(
            "WITH unused AS (SELECT 1), used AS (SELECT 2) SELECT * FROM used"
        )
        types = [i["type"] for i in result["issues"]]
        assert "UNUSED_CTE" in types

    def test_no_issue_when_all_ctes_used(self):
        result = analyze_sql(
            "WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT * FROM b"
        )
        unused = [i for i in result["issues"] if i["type"] == "UNUSED_CTE"]
        assert len(unused) == 0


class TestOrderByInSubquery:
    def test_detects_order_by_in_subquery_without_limit(self):
        result = analyze_sql(
            "SELECT * FROM (SELECT id FROM orders ORDER BY id) sub"
        )
        types = [i["type"] for i in result["issues"]]
        assert "ORDER_BY_IN_SUBQUERY" in types


class TestWindowWithoutPartition:
    def test_detects_window_without_partition(self):
        result = analyze_sql("SELECT ROW_NUMBER() OVER (ORDER BY id) FROM orders")
        types = [i["type"] for i in result["issues"]]
        assert "WINDOW_WITHOUT_PARTITION" in types


class TestOrInJoin:
    def test_detects_or_in_join(self):
        result = analyze_sql(
            "SELECT * FROM a JOIN b ON a.id = b.id OR a.name = b.name"
        )
        types = [i["type"] for i in result["issues"]]
        assert "OR_IN_JOIN" in types


class TestParseError:
    def test_handles_invalid_sql(self):
        result = analyze_sql("NOT VALID SQL AT ALL @@#$")
        assert result["success"] is False
        assert result["confidence"] == "low"


class TestConfidence:
    def test_returns_confidence_fields(self):
        result = analyze_sql("SELECT id FROM orders")
        assert "confidence" in result
        assert "confidence_factors" in result
        assert isinstance(result["confidence_factors"], list)
