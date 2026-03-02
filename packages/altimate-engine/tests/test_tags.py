"""Tests for metadata tags — query governance tags from warehouse system tables."""

from unittest.mock import patch, MagicMock

import pytest

from altimate_engine.schema.tags import get_tags, list_tags


# --- Shared helpers ---


def _mock_snowflake_registry(warehouse_name="my-sf"):
    """Patch ConnectionRegistry to return a mock Snowflake connector."""
    mock_connector = MagicMock()
    mock_connector.execute.return_value = []

    def mock_get(name):
        if name == warehouse_name:
            return mock_connector
        raise ValueError(f"Connection '{name}' not found in registry")

    def mock_list():
        return [{"name": warehouse_name, "type": "snowflake"}]

    return mock_connector, mock_get, mock_list


def _mock_duckdb_registry(warehouse_name="my-duck"):
    mock_connector = MagicMock()

    def mock_get(name):
        if name == warehouse_name:
            return mock_connector
        raise ValueError(f"Connection '{name}' not found in registry")

    def mock_list():
        return [{"name": warehouse_name, "type": "duckdb"}]

    return mock_connector, mock_get, mock_list


# =====================
# get_tags Tests
# =====================


class TestGetTags:
    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_connection_not_found(self, mock_registry):
        mock_registry.get.side_effect = ValueError("Connection 'bad' not found")
        result = get_tags("bad")
        assert result["success"] is False
        assert "not found" in result["error"]
        assert result["tags"] == []

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_non_snowflake_rejected(self, mock_registry):
        connector, mock_get, mock_list = _mock_duckdb_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        result = get_tags("my-duck")
        assert result["success"] is False
        assert "Snowflake" in result["error"]
        assert result["tags"] == []

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_snowflake_success_empty(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = []

        result = get_tags("my-sf")
        assert result["success"] is True
        assert result["tags"] == []
        assert result["tag_count"] == 0
        assert result["tag_summary"] == {}

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_snowflake_with_tags(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = [
            {
                "database_name": "DB1",
                "schema_name": "PUBLIC",
                "tag_name": "PII",
                "tag_value": "true",
                "object_database": "DB1",
                "object_schema": "PUBLIC",
                "object_name": "USERS",
                "column_name": "EMAIL",
                "object_type": "COLUMN",
            },
            {
                "database_name": "DB1",
                "schema_name": "PUBLIC",
                "tag_name": "PII",
                "tag_value": "true",
                "object_database": "DB1",
                "object_schema": "PUBLIC",
                "object_name": "USERS",
                "column_name": "SSN",
                "object_type": "COLUMN",
            },
            {
                "database_name": "DB1",
                "schema_name": "PUBLIC",
                "tag_name": "SENSITIVE",
                "tag_value": "high",
                "object_database": "DB1",
                "object_schema": "PUBLIC",
                "object_name": "USERS",
                "column_name": None,
                "object_type": "TABLE",
            },
        ]

        result = get_tags("my-sf")
        assert result["success"] is True
        assert result["tag_count"] == 3
        assert result["tag_summary"]["PII"] == 2
        assert result["tag_summary"]["SENSITIVE"] == 1

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_with_object_name_filter(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = []

        result = get_tags("my-sf", object_name="DB1.PUBLIC.USERS")
        assert result["success"] is True
        # Verify the SQL contains the object filter
        sql_called = connector.execute.call_args[0][0]
        assert "DB1" in sql_called
        assert "PUBLIC" in sql_called
        assert "USERS" in sql_called

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_with_tag_name_filter(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = []

        result = get_tags("my-sf", tag_name="PII")
        assert result["success"] is True
        sql_called = connector.execute.call_args[0][0]
        assert "PII" in sql_called

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_object_name_two_parts(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = []

        result = get_tags("my-sf", object_name="PUBLIC.USERS")
        assert result["success"] is True
        sql_called = connector.execute.call_args[0][0]
        assert "object_schema" in sql_called

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_object_name_one_part(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = []

        result = get_tags("my-sf", object_name="USERS")
        assert result["success"] is True
        sql_called = connector.execute.call_args[0][0]
        assert "object_name" in sql_called

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_connector_error_handled(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.side_effect = RuntimeError("query timeout")

        result = get_tags("my-sf")
        assert result["success"] is False
        assert "query timeout" in result["error"]


# =====================
# list_tags Tests
# =====================


class TestListTags:
    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_connection_not_found(self, mock_registry):
        mock_registry.get.side_effect = ValueError("Connection 'bad' not found")
        result = list_tags("bad")
        assert result["success"] is False
        assert "not found" in result["error"]

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_non_snowflake_rejected(self, mock_registry):
        connector, mock_get, mock_list = _mock_duckdb_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        result = list_tags("my-duck")
        assert result["success"] is False
        assert "Snowflake" in result["error"]

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_snowflake_success_empty(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = []

        result = list_tags("my-sf")
        assert result["success"] is True
        assert result["tags"] == []
        assert result["tag_count"] == 0

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_snowflake_with_tags(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = [
            {"tag_database": "DB1", "tag_schema": "GOVERNANCE", "tag_name": "PII", "usage_count": 42},
            {"tag_database": "DB1", "tag_schema": "GOVERNANCE", "tag_name": "SENSITIVE", "usage_count": 10},
        ]

        result = list_tags("my-sf")
        assert result["success"] is True
        assert result["tag_count"] == 2

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_connector_error_handled(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.side_effect = RuntimeError("timeout")

        result = list_tags("my-sf")
        assert result["success"] is False
        assert "timeout" in result["error"]

    @patch("altimate_engine.schema.tags.ConnectionRegistry")
    def test_custom_limit(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = []

        result = list_tags("my-sf", limit=10)
        assert result["success"] is True
        sql_called = connector.execute.call_args[0][0]
        assert "10" in sql_called
