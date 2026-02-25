"""Tests for sql.format — SQL formatting / beautification."""

from altimate_engine.sql.formatter import format_sql


class TestFormatSql:
    def test_simple_select(self):
        result = format_sql("select a, b from t", dialect="snowflake")
        assert result["success"] is True
        assert result["statement_count"] == 1
        assert "SELECT" in result["formatted_sql"]

    def test_multiple_statements(self):
        result = format_sql("SELECT 1; SELECT 2;", dialect="snowflake")
        assert result["success"] is True
        assert result["statement_count"] == 2
        assert result["formatted_sql"].endswith(";")

    def test_preserves_trailing_semicolon(self):
        result = format_sql("SELECT 1;", dialect="snowflake")
        assert result["success"] is True
        assert result["formatted_sql"].rstrip().endswith(";")

    def test_no_trailing_semicolon(self):
        result = format_sql("SELECT 1", dialect="snowflake")
        assert result["success"] is True
        assert not result["formatted_sql"].rstrip().endswith(";")

    def test_pretty_prints_keywords(self):
        result = format_sql("select a from t where a > 1 order by a", dialect="snowflake")
        assert result["success"] is True
        # Pretty-printed SQL should have newlines
        assert "\n" in result["formatted_sql"]

    def test_custom_indent(self):
        result = format_sql("SELECT a FROM t WHERE a > 1", dialect="snowflake", indent=4)
        assert result["success"] is True
        # Should have formatted output
        assert result["formatted_sql"] is not None

    def test_different_dialect(self):
        result = format_sql("SELECT a FROM t LIMIT 10", dialect="postgres")
        assert result["success"] is True
        assert result["statement_count"] == 1

    def test_empty_sql_returns_formatted(self):
        # sqlglot handles empty/whitespace SQL gracefully
        result = format_sql("", dialect="snowflake")
        assert result["success"] is True

    def test_complex_query(self):
        sql = """
        SELECT c.name, COUNT(o.id) as order_count, SUM(o.amount) as total
        FROM customers c JOIN orders o ON c.id = o.customer_id
        WHERE o.created_at > '2024-01-01' GROUP BY c.name HAVING COUNT(o.id) > 5
        ORDER BY total DESC LIMIT 10
        """
        result = format_sql(sql, dialect="snowflake")
        assert result["success"] is True
        assert result["statement_count"] == 1
        assert "SELECT" in result["formatted_sql"]
