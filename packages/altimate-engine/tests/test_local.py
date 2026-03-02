"""Tests for local-first DuckDB testing loop -- schema sync and local SQL testing."""

from unittest.mock import patch, MagicMock

import pytest

from altimate_engine.connections import ConnectionRegistry


@pytest.fixture(autouse=True)
def reset_registry():
    ConnectionRegistry._connections = {}
    ConnectionRegistry._loaded = False
    yield
    ConnectionRegistry._connections = {}
    ConnectionRegistry._loaded = False


class TestSyncSchema:
    def test_warehouse_not_found(self):
        from altimate_engine.local.schema_sync import sync_schema

        ConnectionRegistry._loaded = True
        result = sync_schema("nonexistent")
        assert result["success"] is False
        assert "not found" in result["error"]

    @patch("altimate_engine.local.schema_sync.ConnectionRegistry")
    def test_sync_creates_tables(self, mock_registry):
        from altimate_engine.local.schema_sync import sync_schema

        # Mock remote connector
        mock_remote = MagicMock()
        mock_remote.list_schemas.return_value = ["public"]
        mock_remote.list_tables.return_value = [
            {"name": "users", "type": "TABLE"},
            {"name": "orders", "type": "TABLE"},
        ]
        mock_remote.describe_table.side_effect = [
            [
                {"name": "id", "data_type": "INTEGER", "nullable": False},
                {"name": "name", "data_type": "VARCHAR", "nullable": True},
            ],
            [
                {"name": "id", "data_type": "INTEGER", "nullable": False},
                {"name": "user_id", "data_type": "INTEGER", "nullable": True},
                {"name": "total", "data_type": "DECIMAL", "nullable": True},
            ],
        ]

        mock_registry.get.return_value = mock_remote

        result = sync_schema("my-warehouse", target_path=":memory:")
        assert result["success"] is True
        assert result["tables_synced"] == 2
        assert result["columns_synced"] == 5
        assert result["schemas_synced"] == 1

    @patch("altimate_engine.local.schema_sync.ConnectionRegistry")
    def test_sync_with_limit(self, mock_registry):
        from altimate_engine.local.schema_sync import sync_schema

        mock_remote = MagicMock()
        mock_remote.list_schemas.return_value = ["public"]
        mock_remote.list_tables.return_value = [
            {"name": f"table_{i}", "type": "TABLE"} for i in range(10)
        ]
        mock_remote.describe_table.return_value = [
            {"name": "id", "data_type": "INTEGER", "nullable": False},
        ]

        mock_registry.get.return_value = mock_remote

        result = sync_schema("my-warehouse", target_path=":memory:", limit=3)
        assert result["success"] is True
        assert result["tables_synced"] == 3

    @patch("altimate_engine.local.schema_sync.ConnectionRegistry")
    def test_sync_specific_schemas(self, mock_registry):
        from altimate_engine.local.schema_sync import sync_schema

        mock_remote = MagicMock()
        mock_remote.list_tables.return_value = [{"name": "t1", "type": "TABLE"}]
        mock_remote.describe_table.return_value = [
            {"name": "col1", "data_type": "VARCHAR", "nullable": True},
        ]

        mock_registry.get.return_value = mock_remote

        result = sync_schema("wh", target_path=":memory:", schemas=["staging"])
        assert result["success"] is True
        assert result["schemas_synced"] == 1
        # Should not call list_schemas since specific schemas were provided
        mock_remote.list_schemas.assert_not_called()


class TestTestSqlLocal:
    def test_simple_query(self):
        from altimate_engine.local.test_local import test_sql_local

        result = test_sql_local("SELECT 1 AS num, 'hello' AS greeting")
        assert result["success"] is True
        assert result["row_count"] == 1
        assert "num" in result["columns"]

    def test_syntax_error(self):
        from altimate_engine.local.test_local import test_sql_local

        result = test_sql_local("SELECTT 1")
        assert result["success"] is False
        assert result["error"] is not None

    def test_transpile_flag(self):
        from altimate_engine.local.test_local import test_sql_local

        # Snowflake-style SQL that should be transpiled
        result = test_sql_local(
            "SELECT DATEADD('day', 7, CURRENT_TIMESTAMP())",
            target_dialect="snowflake",
        )
        # Should attempt transpilation
        assert "transpiled" in result

    def test_no_transpile_for_duckdb(self):
        from altimate_engine.local.test_local import test_sql_local

        result = test_sql_local("SELECT 42", target_dialect="duckdb")
        assert result["success"] is True
        assert result["transpiled"] is False

    def test_no_transpile_when_no_dialect(self):
        from altimate_engine.local.test_local import test_sql_local

        result = test_sql_local("SELECT 42")
        assert result["success"] is True
        assert result["transpiled"] is False

    def test_multiple_rows(self):
        from altimate_engine.local.test_local import test_sql_local

        result = test_sql_local(
            "SELECT * FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) AS t(id, name)"
        )
        assert result["success"] is True
        assert result["row_count"] == 3
        assert len(result["columns"]) == 2

    def test_empty_result(self):
        from altimate_engine.local.test_local import test_sql_local

        result = test_sql_local("SELECT 1 WHERE 1 = 0")
        assert result["success"] is True
        assert result["row_count"] == 0


class TestTypeMapping:
    def test_common_types(self):
        from altimate_engine.local.schema_sync import _map_type

        assert _map_type("INTEGER") == "INTEGER"
        assert _map_type("VARCHAR") == "VARCHAR"
        assert _map_type("BOOLEAN") == "BOOLEAN"
        assert _map_type("TIMESTAMP") == "TIMESTAMP"
        assert _map_type("FLOAT") == "FLOAT"
        assert _map_type("VARIANT") == "JSON"
        assert _map_type("NUMBER") == "DECIMAL"

    def test_unknown_type_defaults_to_varchar(self):
        from altimate_engine.local.schema_sync import _map_type

        assert _map_type("SPECIAL_CUSTOM_TYPE") == "VARCHAR"

    def test_parameterized_types(self):
        from altimate_engine.local.schema_sync import _map_type

        assert _map_type("VARCHAR(255)") == "VARCHAR"
        assert _map_type("DECIMAL(18,2)") == "DECIMAL"

    def test_snowflake_specific_types(self):
        from altimate_engine.local.schema_sync import _map_type

        assert _map_type("TIMESTAMP_NTZ") == "TIMESTAMP"
        assert _map_type("TIMESTAMP_LTZ") == "TIMESTAMPTZ"
        assert _map_type("TIMESTAMP_TZ") == "TIMESTAMPTZ"
        assert _map_type("OBJECT") == "JSON"
        assert _map_type("ARRAY") == "JSON"

    def test_case_insensitive_via_upper(self):
        from altimate_engine.local.schema_sync import _map_type

        # _map_type uppercases internally
        assert _map_type("integer") == "INTEGER"
        assert _map_type("varchar") == "VARCHAR"
        assert _map_type("boolean") == "BOOLEAN"
