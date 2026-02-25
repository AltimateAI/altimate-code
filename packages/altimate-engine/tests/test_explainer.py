"""Tests for sql.explain — EXPLAIN query building (unit tests without live warehouse)."""

from altimate_engine.sql.explainer import _build_explain_query, explain_sql
from altimate_engine.models import SqlExplainParams


class TestBuildExplainQuery:
    def test_snowflake_explain(self):
        q = _build_explain_query("SELECT 1", "snowflake", analyze=False)
        assert q == "EXPLAIN USING TEXT SELECT 1"

    def test_snowflake_ignores_analyze(self):
        # Snowflake doesn't support EXPLAIN ANALYZE
        q = _build_explain_query("SELECT 1", "snowflake", analyze=True)
        assert q == "EXPLAIN USING TEXT SELECT 1"

    def test_postgres_explain(self):
        q = _build_explain_query("SELECT 1", "postgres", analyze=False)
        assert q == "EXPLAIN (FORMAT TEXT) SELECT 1"

    def test_postgres_explain_analyze(self):
        q = _build_explain_query("SELECT 1", "postgres", analyze=True)
        assert q == "EXPLAIN (ANALYZE, FORMAT TEXT) SELECT 1"

    def test_duckdb_explain(self):
        q = _build_explain_query("SELECT 1", "duckdb", analyze=False)
        assert q == "EXPLAIN SELECT 1"

    def test_duckdb_explain_analyze(self):
        q = _build_explain_query("SELECT 1", "duckdb", analyze=True)
        assert q == "EXPLAIN ANALYZE SELECT 1"

    def test_generic_dialect(self):
        q = _build_explain_query("SELECT 1", "bigquery", analyze=False)
        assert q == "EXPLAIN SELECT 1"

    def test_generic_dialect_analyze(self):
        q = _build_explain_query("SELECT 1", "bigquery", analyze=True)
        assert q == "EXPLAIN ANALYZE SELECT 1"

    def test_strips_trailing_semicolon(self):
        q = _build_explain_query("SELECT 1;", "postgres", analyze=False)
        assert q == "EXPLAIN (FORMAT TEXT) SELECT 1"
        assert not q.endswith(";")

    def test_strips_multiple_semicolons(self):
        q = _build_explain_query("SELECT 1;;", "postgres", analyze=False)
        assert not q.rstrip().endswith(";")


class TestExplainSqlNoWarehouse:
    def test_no_warehouse_returns_error(self):
        params = SqlExplainParams(sql="SELECT 1", warehouse=None)
        result = explain_sql(params)
        assert result.success is False
        assert "No warehouse" in result.error

    def test_missing_warehouse_returns_error(self):
        params = SqlExplainParams(sql="SELECT 1", warehouse="nonexistent")
        result = explain_sql(params)
        assert result.success is False
        assert "not found" in result.error
