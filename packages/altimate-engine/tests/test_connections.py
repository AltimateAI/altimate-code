"""Tests for connections.py — ConnectionRegistry loading, connector instantiation, and testing."""

import json
import os
from unittest.mock import patch, MagicMock

import pytest

from altimate_engine.connections import ConnectionRegistry, SSH_FIELDS
import altimate_engine.credential_store as _cred_mod


@pytest.fixture(autouse=True)
def reset_registry():
    """Reset the ConnectionRegistry class state and keyring cache before each test."""
    ConnectionRegistry._connections = {}
    ConnectionRegistry._loaded = False
    _cred_mod._keyring_cache = None
    yield
    ConnectionRegistry._connections = {}
    ConnectionRegistry._loaded = False
    _cred_mod._keyring_cache = None


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


class TestSSHFields:
    """SSH field constant validation."""

    def test_ssh_fields_complete(self):
        assert "ssh_host" in SSH_FIELDS
        assert "ssh_port" in SSH_FIELDS
        assert "ssh_user" in SSH_FIELDS
        assert "ssh_auth_type" in SSH_FIELDS
        assert "ssh_key_path" in SSH_FIELDS
        assert "ssh_password" in SSH_FIELDS


class TestConnectionRegistryGetWithSSH:
    """SSH tunnel integration in get()."""

    def test_ssh_rewrites_host_and_port(self):
        """When ssh_host is present, get() should tunnel and rewrite host/port."""
        ConnectionRegistry._connections = {
            "ssh_pg": {
                "type": "duckdb",
                "path": ":memory:",
                "host": "10.0.1.50",
                "port": 5432,
                "ssh_host": "bastion.example.com",
                "ssh_user": "deploy",
                "ssh_auth_type": "key",
                "ssh_key_path": "/home/.ssh/id_rsa",
            }
        }
        ConnectionRegistry._loaded = True

        with patch("altimate_engine.connections.resolve_config", side_effect=lambda n, c: dict(c)), \
             patch("altimate_engine.connections.start", return_value=54321) as mock_start:
            connector = ConnectionRegistry.get("ssh_pg")
            mock_start.assert_called_once()
            call_kwargs = mock_start.call_args
            assert call_kwargs.kwargs.get("ssh_host") == "bastion.example.com" or \
                   call_kwargs[1].get("ssh_host") == "bastion.example.com"

    def test_ssh_with_connection_string_raises(self):
        """SSH + connection_string should raise ValueError."""
        ConnectionRegistry._connections = {
            "bad": {
                "type": "postgres",
                "connection_string": "postgres://localhost/db",
                "ssh_host": "bastion.example.com",
            }
        }
        ConnectionRegistry._loaded = True

        with patch("altimate_engine.connections.resolve_config", side_effect=lambda n, c: dict(c)):
            with pytest.raises(ValueError, match="SSH tunneling requires explicit host/port"):
                ConnectionRegistry.get("bad")

    def test_ssh_fields_stripped_from_config(self):
        """SSH fields should not leak into connector kwargs."""
        ConnectionRegistry._connections = {
            "ssh_duck": {
                "type": "duckdb",
                "path": ":memory:",
                "ssh_host": "bastion.example.com",
                "ssh_user": "deploy",
                "ssh_auth_type": "key",
            }
        }
        ConnectionRegistry._loaded = True

        with patch("altimate_engine.connections.resolve_config", side_effect=lambda n, c: dict(c)), \
             patch("altimate_engine.connections.start", return_value=54321):
            connector = ConnectionRegistry.get("ssh_duck")
            # SSH fields should not appear in connector options
            for field in SSH_FIELDS:
                assert field not in connector.options


class TestConnectionRegistryGetWithResolveConfig:
    """Secret resolution via resolve_config in get()."""

    def test_resolve_config_called_on_get(self):
        """get() should call resolve_config before creating connector."""
        ConnectionRegistry._connections = {
            "resolved": {"type": "duckdb", "path": ":memory:", "password": None}
        }
        ConnectionRegistry._loaded = True

        with patch("altimate_engine.connections.resolve_config") as mock_resolve:
            mock_resolve.return_value = {"type": "duckdb", "path": ":memory:"}
            ConnectionRegistry.get("resolved")
            mock_resolve.assert_called_once_with("resolved", {"type": "duckdb", "path": ":memory:", "password": None})


class TestConnectionRegistryAdd:
    """Adding connections via add()."""

    def test_add_delegates_to_save_connection(self):
        with patch("altimate_engine.credential_store.save_connection") as mock_save:
            mock_save.return_value = {"type": "duckdb", "path": ":memory:"}
            result = ConnectionRegistry.add("new_db", {"type": "duckdb", "path": ":memory:"})
            mock_save.assert_called_once_with("new_db", {"type": "duckdb", "path": ":memory:"})
            assert result["type"] == "duckdb"

    def test_add_resets_loaded_flag(self):
        ConnectionRegistry._loaded = True
        with patch("altimate_engine.credential_store.save_connection", return_value={}):
            ConnectionRegistry.add("db", {"type": "duckdb"})
        assert ConnectionRegistry._loaded is False


class TestConnectionRegistryRemove:
    """Removing connections via remove()."""

    def test_remove_delegates_to_remove_connection(self):
        with patch("altimate_engine.credential_store.remove_connection") as mock_remove:
            mock_remove.return_value = True
            result = ConnectionRegistry.remove("old_db")
            mock_remove.assert_called_once_with("old_db")
            assert result is True

    def test_remove_resets_loaded_flag(self):
        ConnectionRegistry._loaded = True
        with patch("altimate_engine.credential_store.remove_connection", return_value=False):
            ConnectionRegistry.remove("db")
        assert ConnectionRegistry._loaded is False


class TestConnectionRegistryReload:
    """Reloading the registry."""

    def test_reload_clears_state(self):
        ConnectionRegistry._connections = {"db": {"type": "duckdb"}}
        ConnectionRegistry._loaded = True

        ConnectionRegistry.reload()

        assert ConnectionRegistry._loaded is False
        assert ConnectionRegistry._connections == {}


class TestConnectionRegistryTestWithTunnelCleanup:
    """test() should clean up SSH tunnels in finally block."""

    def test_tunnel_stopped_on_success(self):
        ConnectionRegistry._connections = {"duck": {"type": "duckdb", "path": ":memory:"}}
        ConnectionRegistry._loaded = True

        with patch("altimate_engine.connections.stop") as mock_stop:
            ConnectionRegistry.test("duck")
            mock_stop.assert_called_once_with("duck")

    def test_tunnel_stopped_on_failure(self):
        ConnectionRegistry._connections = {}
        ConnectionRegistry._loaded = True

        with patch("altimate_engine.connections.stop") as mock_stop:
            ConnectionRegistry.test("nonexistent")
            mock_stop.assert_called_once_with("nonexistent")
