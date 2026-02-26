"""Tests for connections.py — ConnectionRegistry loading, connector instantiation, and testing."""

import json
import os
from unittest.mock import patch, MagicMock

import pytest

from altimate_engine.connections import ConnectionRegistry


@pytest.fixture(autouse=True)
def reset_registry():
    """Reset the ConnectionRegistry class state before each test."""
    ConnectionRegistry._connections = {}
    ConnectionRegistry._loaded = False
    yield
    ConnectionRegistry._connections = {}
    ConnectionRegistry._loaded = False


class TestConnectionRegistryLoad:
    """Loading connections from config files and environment variables."""

    def test_load_from_global_config(self, tmp_path):
        """Connections from ~/.altimate-code/connections.json should be loaded."""
        config = {
            "my_duckdb": {"type": "duckdb", "path": ":memory:"},
        }
        global_dir = tmp_path / ".altimate-code"
        global_dir.mkdir()
        config_file = global_dir / "connections.json"
        config_file.write_text(json.dumps(config))

        with patch("pathlib.Path.home", return_value=tmp_path), \
             patch("pathlib.Path.cwd", return_value=tmp_path / "nonexistent"):
            ConnectionRegistry.load()

        assert "my_duckdb" in ConnectionRegistry._connections
        assert ConnectionRegistry._loaded is True

    def test_load_from_project_config(self, tmp_path):
        """Connections from .altimate-code/connections.json in cwd should be loaded."""
        config = {
            "project_db": {"type": "duckdb", "path": ":memory:"},
        }
        project_dir = tmp_path / ".altimate-code"
        project_dir.mkdir()
        config_file = project_dir / "connections.json"
        config_file.write_text(json.dumps(config))

        with patch("pathlib.Path.home", return_value=tmp_path / "fakehome"), \
             patch("pathlib.Path.cwd", return_value=tmp_path):
            ConnectionRegistry.load()

        assert "project_db" in ConnectionRegistry._connections

    def test_project_overrides_global(self, tmp_path):
        """Project config should override global config for same key."""
        global_dir = tmp_path / "home" / ".altimate-code"
        global_dir.mkdir(parents=True)
        (global_dir / "connections.json").write_text(
            json.dumps({"db": {"type": "duckdb", "path": "/global"}})
        )

        project_dir = tmp_path / "project" / ".altimate-code"
        project_dir.mkdir(parents=True)
        (project_dir / "connections.json").write_text(
            json.dumps({"db": {"type": "duckdb", "path": "/project"}})
        )

        with patch("pathlib.Path.home", return_value=tmp_path / "home"), \
             patch("pathlib.Path.cwd", return_value=tmp_path / "project"):
            ConnectionRegistry.load()

        assert ConnectionRegistry._connections["db"]["path"] == "/project"

    def test_load_from_env_vars(self, tmp_path):
        """Environment variables ALTIMATE_CODE_CONN_* should be loaded."""
        env_config = json.dumps({"type": "duckdb", "path": ":memory:"})

        with patch("pathlib.Path.home", return_value=tmp_path / "fakehome"), \
             patch("pathlib.Path.cwd", return_value=tmp_path / "fakecwd"), \
             patch.dict(os.environ, {"ALTIMATE_CODE_CONN_MYDB": env_config}, clear=False):
            ConnectionRegistry.load()

        assert "mydb" in ConnectionRegistry._connections
        assert ConnectionRegistry._connections["mydb"]["type"] == "duckdb"

    def test_env_var_name_lowercased(self, tmp_path):
        """Connection name from env var should be lowercased."""
        env_config = json.dumps({"type": "duckdb"})

        with patch("pathlib.Path.home", return_value=tmp_path / "fh"), \
             patch("pathlib.Path.cwd", return_value=tmp_path / "fc"), \
             patch.dict(os.environ, {"ALTIMATE_CODE_CONN_MY_DB": env_config}, clear=False):
            ConnectionRegistry.load()

        assert "my_db" in ConnectionRegistry._connections

    def test_invalid_env_var_json_skipped(self, tmp_path):
        """Invalid JSON in env var should be silently skipped."""
        with patch("pathlib.Path.home", return_value=tmp_path / "fh"), \
             patch("pathlib.Path.cwd", return_value=tmp_path / "fc"), \
             patch.dict(os.environ, {"ALTIMATE_CODE_CONN_BAD": "not json{{"}, clear=False):
            ConnectionRegistry.load()

        assert "bad" not in ConnectionRegistry._connections

    def test_load_is_idempotent(self, tmp_path):
        """Calling load() multiple times should only load once."""
        config = {"db1": {"type": "duckdb"}}
        global_dir = tmp_path / ".altimate-code"
        global_dir.mkdir()
        (global_dir / "connections.json").write_text(json.dumps(config))

        with patch("pathlib.Path.home", return_value=tmp_path), \
             patch("pathlib.Path.cwd", return_value=tmp_path / "fc"):
            ConnectionRegistry.load()
            # Modify the file after loading
            (global_dir / "connections.json").write_text(
                json.dumps({"db1": {"type": "duckdb"}, "db2": {"type": "postgres"}})
            )
            ConnectionRegistry.load()  # Should not reload

        assert "db2" not in ConnectionRegistry._connections

    def test_no_config_files_at_all(self, tmp_path):
        """If no config files exist and no env vars, connections should be empty."""
        with patch("pathlib.Path.home", return_value=tmp_path / "fh"), \
             patch("pathlib.Path.cwd", return_value=tmp_path / "fc"):
            ConnectionRegistry.load()

        assert ConnectionRegistry._connections == {}
        assert ConnectionRegistry._loaded is True


class TestConnectionRegistryGet:
    """Getting connectors by name."""

    def test_get_duckdb_connector(self, tmp_path):
        """DuckDB connector should be instantiated for type=duckdb."""
        ConnectionRegistry._connections = {"test_db": {"type": "duckdb", "path": ":memory:"}}
        ConnectionRegistry._loaded = True

        from altimate_engine.connectors.duckdb import DuckDBConnector

        connector = ConnectionRegistry.get("test_db")
        assert isinstance(connector, DuckDBConnector)
        assert connector.path == ":memory:"

    def test_get_default_type_is_duckdb(self):
        """When type is omitted, it should default to duckdb."""
        ConnectionRegistry._connections = {"no_type": {"path": ":memory:"}}
        ConnectionRegistry._loaded = True

        from altimate_engine.connectors.duckdb import DuckDBConnector

        connector = ConnectionRegistry.get("no_type")
        assert isinstance(connector, DuckDBConnector)

    def test_get_unknown_name_raises_value_error(self):
        """Requesting a non-existent connection should raise ValueError."""
        ConnectionRegistry._connections = {}
        ConnectionRegistry._loaded = True

        with pytest.raises(ValueError, match="not found"):
            ConnectionRegistry.get("nonexistent")

    def test_get_unsupported_type_raises_value_error(self):
        """Unsupported connector type should raise ValueError."""
        ConnectionRegistry._connections = {"bad": {"type": "oracle"}}
        ConnectionRegistry._loaded = True

        with pytest.raises(ValueError, match="Unsupported"):
            ConnectionRegistry.get("bad")

    def test_get_triggers_load_if_not_loaded(self, tmp_path):
        """get() should call load() first if not already loaded."""
        ConnectionRegistry._loaded = False
        ConnectionRegistry._connections = {}

        # Set up a config file so load succeeds and adds a connection
        global_dir = tmp_path / ".altimate-code"
        global_dir.mkdir()
        (global_dir / "connections.json").write_text(
            json.dumps({"auto_load_db": {"type": "duckdb", "path": ":memory:"}})
        )

        with patch("pathlib.Path.home", return_value=tmp_path), \
             patch("pathlib.Path.cwd", return_value=tmp_path / "fc"):
            connector = ConnectionRegistry.get("auto_load_db")

        from altimate_engine.connectors.duckdb import DuckDBConnector
        assert isinstance(connector, DuckDBConnector)

    def test_get_duckdb_default_memory(self):
        """DuckDB with no path should default to :memory:."""
        ConnectionRegistry._connections = {"memdb": {"type": "duckdb"}}
        ConnectionRegistry._loaded = True

        connector = ConnectionRegistry.get("memdb")
        assert connector.path == ":memory:"

    def test_get_postgres_connector(self):
        """Postgres connector should be instantiated for type=postgres."""
        ConnectionRegistry._connections = {
            "pg": {"type": "postgres", "connection_string": "postgres://localhost/db"}
        }
        ConnectionRegistry._loaded = True

        from altimate_engine.connectors.postgres import PostgresConnector

        connector = ConnectionRegistry.get("pg")
        assert isinstance(connector, PostgresConnector)

    def test_get_snowflake_connector(self):
        """Snowflake connector should be instantiated for type=snowflake."""
        ConnectionRegistry._connections = {
            "sf": {
                "type": "snowflake",
                "account": "my_account",
                "user": "my_user",
                "password": "my_pass",
                "warehouse": "COMPUTE_WH",
                "database": "MY_DB",
                "schema": "PUBLIC",
            }
        }
        ConnectionRegistry._loaded = True

        from altimate_engine.connectors.snowflake import SnowflakeConnector

        connector = ConnectionRegistry.get("sf")
        assert isinstance(connector, SnowflakeConnector)


class TestConnectionRegistryList:
    """Listing configured connections."""

    def test_list_empty(self):
        """Empty registry should return empty list."""
        ConnectionRegistry._connections = {}
        ConnectionRegistry._loaded = True

        result = ConnectionRegistry.list()
        assert result == []

    def test_list_returns_name_and_type(self):
        """Each entry should have name and type."""
        ConnectionRegistry._connections = {
            "db1": {"type": "duckdb"},
            "db2": {"type": "postgres", "connection_string": "..."},
        }
        ConnectionRegistry._loaded = True

        result = ConnectionRegistry.list()
        assert len(result) == 2
        names = {r["name"] for r in result}
        assert names == {"db1", "db2"}
        types = {r["type"] for r in result}
        assert "duckdb" in types
        assert "postgres" in types

    def test_list_unknown_type_shows_unknown(self):
        """Missing 'type' key should default to 'unknown'."""
        ConnectionRegistry._connections = {"no_type": {"path": ":memory:"}}
        ConnectionRegistry._loaded = True

        result = ConnectionRegistry.list()
        # The list method uses config.get("type", "unknown")
        assert result[0]["type"] == "unknown"


class TestConnectionRegistryTest:
    """Testing connections."""

    def test_successful_connection(self):
        """Working DuckDB connection should return connected=True."""
        ConnectionRegistry._connections = {"test_duck": {"type": "duckdb", "path": ":memory:"}}
        ConnectionRegistry._loaded = True

        result = ConnectionRegistry.test("test_duck")
        assert result["connected"] is True
        assert result["error"] is None

    def test_failed_connection(self):
        """Non-existent connection should return connected=False with error."""
        ConnectionRegistry._connections = {}
        ConnectionRegistry._loaded = True

        result = ConnectionRegistry.test("nonexistent")
        assert result["connected"] is False
        assert result["error"] is not None

    def test_failed_connector_returns_error(self):
        """A connector that can't connect should return connected=False."""
        ConnectionRegistry._connections = {
            "bad_pg": {"type": "postgres", "connection_string": "postgres://badhost:5432/nope"}
        }
        ConnectionRegistry._loaded = True

        result = ConnectionRegistry.test("bad_pg")
        assert result["connected"] is False
        assert result["error"] is not None


class TestDuckDBConnectorIntegration:
    """Full integration test using a real DuckDB in-memory connector."""

    def test_full_workflow(self):
        """Load config, get connector, execute, close."""
        ConnectionRegistry._connections = {"mem": {"type": "duckdb", "path": ":memory:"}}
        ConnectionRegistry._loaded = True

        connector = ConnectionRegistry.get("mem")
        connector.connect()
        result = connector.execute("SELECT 1 + 1 AS sum_val")
        assert result[0]["sum_val"] == 2
        connector.close()

    def test_context_manager(self):
        """Connector should work as a context manager."""
        ConnectionRegistry._connections = {"ctx": {"type": "duckdb", "path": ":memory:"}}
        ConnectionRegistry._loaded = True

        connector = ConnectionRegistry.get("ctx")
        with connector:
            result = connector.execute("SELECT 42 AS answer")
            assert result[0]["answer"] == 42

    def test_extra_kwargs_passed_through(self):
        """Extra config keys should be passed as kwargs to the connector."""
        ConnectionRegistry._connections = {
            "extra": {"type": "duckdb", "path": ":memory:", "read_only": False}
        }
        ConnectionRegistry._loaded = True

        connector = ConnectionRegistry.get("extra")
        assert connector.options.get("read_only") is False
