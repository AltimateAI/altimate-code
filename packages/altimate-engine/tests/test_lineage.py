"""Tests for lineage checking."""

import pytest
from altimate_engine.lineage.check import check_lineage, _get_target_table
from altimate_engine.models import LineageCheckParams

import sqlglot
from sqlglot import exp


class TestCheckLineage:
    def test_simple_select(self):
        result = check_lineage(LineageCheckParams(
            sql="SELECT a.id, a.name FROM users a",
            dialect="snowflake",
        ))
        assert len(result.edges) > 0
        assert "a" in result.tables

    def test_alias_column(self):
        result = check_lineage(LineageCheckParams(
            sql="SELECT id AS user_id FROM users",
            dialect="snowflake",
        ))
        edge_targets = [e.target_column for e in result.edges]
        assert "user_id" in edge_targets

    def test_confidence_with_select_star(self):
        result = check_lineage(LineageCheckParams(
            sql="SELECT * FROM users",
            dialect="snowflake",
        ))
        assert result.confidence == "low"
        assert any("SELECT *" in f for f in result.confidence_factors)

    def test_confidence_without_schema_context(self):
        result = check_lineage(LineageCheckParams(
            sql="SELECT id FROM users",
            dialect="snowflake",
        ))
        assert result.confidence in ("medium", "low")
        assert any("schema context" in f.lower() for f in result.confidence_factors)

    def test_jinja_detection(self):
        result = check_lineage(LineageCheckParams(
            sql="SELECT {{ column }} FROM {{ ref('model') }}",
            dialect="snowflake",
        ))
        assert result.confidence == "low"
        assert any("Jinja" in f for f in result.confidence_factors)

    def test_column_names_not_in_tables(self):
        """Regression: column names should not appear in the tables set."""
        result = check_lineage(LineageCheckParams(
            sql="SELECT id, name FROM users",
            dialect="snowflake",
        ))
        # 'id' and 'name' should be in columns, not tables
        assert "id" in result.columns
        assert "name" in result.columns
        # Only actual table references should be in tables
        for table in result.tables:
            assert table not in ("id", "name"), f"Column '{table}' should not be in tables set"

    def test_function_alias_lineage(self):
        """Functions wrapped in aliases should trace inner columns."""
        result = check_lineage(LineageCheckParams(
            sql="SELECT UPPER(u.name) AS upper_name FROM users u",
            dialect="snowflake",
        ))
        edge_targets = [e.target_column for e in result.edges]
        assert "upper_name" in edge_targets


class TestGetTargetTable:
    def test_simple_from(self):
        ast = sqlglot.parse_one("SELECT id FROM users", dialect="snowflake")
        select = ast if isinstance(ast, exp.Select) else ast.find(exp.Select)
        assert _get_target_table(select) == "users"

    def test_aliased_table(self):
        ast = sqlglot.parse_one("SELECT id FROM users u", dialect="snowflake")
        select = ast if isinstance(ast, exp.Select) else ast.find(exp.Select)
        assert _get_target_table(select) == "u"

    def test_subquery_in_from(self):
        """Subquery in FROM should return the subquery alias, not inner table."""
        ast = sqlglot.parse_one(
            "SELECT a.id FROM (SELECT id FROM t) a",
            dialect="snowflake",
        )
        select = ast if isinstance(ast, exp.Select) else ast.find(exp.Select)
        result = _get_target_table(select)
        assert result == "a", f"Expected 'a' but got '{result}'"

    def test_no_from(self):
        ast = sqlglot.parse_one("SELECT 1", dialect="snowflake")
        select = ast if isinstance(ast, exp.Select) else ast.find(exp.Select)
        assert _get_target_table(select) == "unknown"
