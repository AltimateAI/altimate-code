"""Tests for sql/executor.py — SQL execution against warehouse connections."""

from unittest.mock import MagicMock, patch

import pytest

from altimate_engine.models import SqlExecuteParams, SqlExecuteResult
from altimate_engine.sql.executor import execute_sql


class TestExecuteSqlNoWarehouse:
    """When no warehouse is specified."""

    def test_no_warehouse_returns_error(self):
        """Should return an error result when warehouse is None."""
        params = SqlExecuteParams(sql="SELECT 1", warehouse=None)
        result = execute_sql(params)
        assert isinstance(result, SqlExecuteResult)
        assert result.columns == ["error"]
        assert "No warehouse" in result.rows[0][0]
        assert result.row_count == 1
        assert result.truncated is False

    def test_empty_warehouse_returns_error(self):
        """Empty string warehouse should also return an error."""
        params = SqlExecuteParams(sql="SELECT 1", warehouse="")
        result = execute_sql(params)
        assert result.columns == ["error"]
        assert "No warehouse" in result.rows[0][0]


class TestExecuteSqlConnectionNotFound:
    """When the warehouse connection is not in the registry."""

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_unknown_connection_returns_error(self, mock_registry):
        """Unknown warehouse name that isn't a postgres string should give error."""
        mock_registry.get.side_effect = ValueError("Connection 'unknown_wh' not found")
        params = SqlExecuteParams(sql="SELECT 1", warehouse="unknown_wh")
        result = execute_sql(params)
        assert result.columns == ["error"]
        assert "not found" in result.rows[0][0]
        assert result.truncated is False

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_postgres_fallback_triggered(self, mock_registry):
        """When warehouse starts with 'postgres' and not in registry, fallback kicks in."""
        mock_registry.get.side_effect = ValueError("Not found")
        params = SqlExecuteParams(sql="SELECT 1", warehouse="postgres://localhost/db")
        result = execute_sql(params)
        # psycopg2 may or may not be installed; either way it should not raise
        assert isinstance(result, SqlExecuteResult)
        # If psycopg2 not installed, it returns an error about missing package
        # If psycopg2 is installed but can't connect, it returns a connection error
        assert result.row_count >= 1


class TestExecuteSqlSuccessful:
    """Successful execution through ConnectionRegistry."""

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_successful_query(self, mock_registry):
        """Normal successful query should return results."""
        mock_connector = MagicMock()
        mock_connector.execute.return_value = [
            {"id": 1, "name": "Alice"},
            {"id": 2, "name": "Bob"},
        ]
        mock_registry.get.return_value = mock_connector

        params = SqlExecuteParams(sql="SELECT id, name FROM users", warehouse="my_wh", limit=100)
        result = execute_sql(params)

        assert result.columns == ["id", "name"]
        assert result.rows == [[1, "Alice"], [2, "Bob"]]
        assert result.row_count == 2
        assert result.truncated is False
        mock_connector.connect.assert_called_once()
        mock_connector.execute.assert_called_once_with("SELECT id, name FROM users", limit=101)
        mock_connector.close.assert_called_once()

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_empty_result_set(self, mock_registry):
        """DDL or queries with no rows should return a success message."""
        mock_connector = MagicMock()
        mock_connector.execute.return_value = []
        mock_registry.get.return_value = mock_connector

        params = SqlExecuteParams(sql="CREATE TABLE t (id INT)", warehouse="my_wh")
        result = execute_sql(params)

        assert result.columns == ["status"]
        assert "successfully" in result.rows[0][0].lower()
        assert result.row_count == 0
        assert result.truncated is False


class TestExecuteSqlTruncation:
    """Result truncation when row count exceeds limit."""

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_truncation_when_exceeding_limit(self, mock_registry):
        """When rows > limit, result should be truncated."""
        # Simulate limit=2, connector returns 3 rows (limit+1)
        mock_connector = MagicMock()
        mock_connector.execute.return_value = [
            {"id": 1},
            {"id": 2},
            {"id": 3},
        ]
        mock_registry.get.return_value = mock_connector

        params = SqlExecuteParams(sql="SELECT id FROM t", warehouse="wh", limit=2)
        result = execute_sql(params)

        assert result.truncated is True
        assert result.row_count == 2
        assert len(result.rows) == 2

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_no_truncation_when_within_limit(self, mock_registry):
        """When rows <= limit, result should not be truncated."""
        mock_connector = MagicMock()
        mock_connector.execute.return_value = [
            {"id": 1},
            {"id": 2},
        ]
        mock_registry.get.return_value = mock_connector

        params = SqlExecuteParams(sql="SELECT id FROM t", warehouse="wh", limit=10)
        result = execute_sql(params)

        assert result.truncated is False
        assert result.row_count == 2

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_exact_limit_count_not_truncated(self, mock_registry):
        """When rows exactly equal limit, it should not be truncated."""
        mock_connector = MagicMock()
        # Connector returns exactly limit rows (not limit+1)
        mock_connector.execute.return_value = [
            {"id": 1},
            {"id": 2},
            {"id": 3},
        ]
        mock_registry.get.return_value = mock_connector

        params = SqlExecuteParams(sql="SELECT id FROM t", warehouse="wh", limit=3)
        result = execute_sql(params)

        assert result.truncated is False
        assert result.row_count == 3


class TestExecuteSqlConnectorError:
    """When the connector raises an exception during execution."""

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_connector_error_returns_error_result(self, mock_registry):
        """Exceptions from connector should be caught and returned as error."""
        mock_connector = MagicMock()
        mock_connector.execute.side_effect = RuntimeError("Connection timeout")
        mock_registry.get.return_value = mock_connector

        params = SqlExecuteParams(sql="SELECT 1", warehouse="wh")
        result = execute_sql(params)

        assert result.columns == ["error"]
        assert "Connection timeout" in result.rows[0][0]
        assert result.row_count == 1

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_connect_error_returns_error_result(self, mock_registry):
        """If connect() itself fails, it should be caught."""
        mock_connector = MagicMock()
        mock_connector.connect.side_effect = RuntimeError("Cannot connect")
        mock_registry.get.return_value = mock_connector

        params = SqlExecuteParams(sql="SELECT 1", warehouse="wh")
        result = execute_sql(params)

        assert result.columns == ["error"]
        assert "Cannot connect" in result.rows[0][0]


class TestExecuteSqlLimitEnforcement:
    """Verify that the limit parameter is passed correctly to the connector."""

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_default_limit(self, mock_registry):
        """Default limit should be 500, passed as 501 to connector."""
        mock_connector = MagicMock()
        mock_connector.execute.return_value = [{"x": 1}]
        mock_registry.get.return_value = mock_connector

        params = SqlExecuteParams(sql="SELECT 1", warehouse="wh")
        execute_sql(params)

        # Default limit is 500, so connector gets 501
        mock_connector.execute.assert_called_with("SELECT 1", limit=501)

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_custom_limit(self, mock_registry):
        """Custom limit should be passed as limit+1 to connector."""
        mock_connector = MagicMock()
        mock_connector.execute.return_value = [{"x": 1}]
        mock_registry.get.return_value = mock_connector

        params = SqlExecuteParams(sql="SELECT 1", warehouse="wh", limit=10)
        execute_sql(params)

        mock_connector.execute.assert_called_with("SELECT 1", limit=11)


class TestPostgresRawFallback:
    """Test _execute_postgres_raw path."""

    @patch("altimate_engine.sql.executor.ConnectionRegistry")
    def test_postgres_fallback_no_psycopg2(self, mock_registry):
        """When psycopg2 is not available, return helpful error."""
        mock_registry.get.side_effect = ValueError("Not found")
        params = SqlExecuteParams(sql="SELECT 1", warehouse="postgres://localhost/db")
        result = execute_sql(params)
        assert isinstance(result, SqlExecuteResult)
        # Result should either work or show an error
        assert len(result.rows) >= 1


class TestSqlExecuteParamsModel:
    """Test the SqlExecuteParams pydantic model."""

    def test_default_values(self):
        params = SqlExecuteParams(sql="SELECT 1")
        assert params.warehouse is None
        assert params.limit == 500

    def test_custom_values(self):
        params = SqlExecuteParams(sql="SELECT 1", warehouse="my_wh", limit=10)
        assert params.warehouse == "my_wh"
        assert params.limit == 10
