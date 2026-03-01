"""Tests for credential_store module."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from altimate_engine.credential_store import (
    SENSITIVE_FIELDS,
    _keyring_available,
    store_credential,
    get_credential,
    delete_all_credentials,
    resolve_config,
    save_connection,
    remove_connection,
)
import altimate_engine.credential_store as _cred_mod


@pytest.fixture(autouse=True)
def reset_keyring_cache():
    """Reset the keyring cache before and after each test."""
    _cred_mod._keyring_cache = None
    yield
    _cred_mod._keyring_cache = None


class TestKeyringAvailability:
    def test_keyring_not_installed(self):
        import altimate_engine.credential_store as mod

        mod._keyring_cache = None
        with patch.dict("sys.modules", {"keyring": None}):
            with patch("builtins.__import__", side_effect=ImportError):
                mod._keyring_cache = None
                assert mod._keyring_available() is False

    def test_caches_result(self):
        import altimate_engine.credential_store as mod

        mod._keyring_cache = True
        assert mod._keyring_available() is True
        mod._keyring_cache = None


class TestStoreCredential:
    def test_returns_false_when_no_keyring(self):
        with patch("altimate_engine.credential_store._keyring_available", return_value=False):
            assert store_credential("test", "password", "secret") is False

    def test_stores_in_keyring(self):
        mock_keyring = MagicMock()
        with patch("altimate_engine.credential_store._keyring_available", return_value=True):
            with patch.dict("sys.modules", {"keyring": mock_keyring}):
                with patch("altimate_engine.credential_store.keyring", mock_keyring, create=True):
                    # Reimport to get the lazy import to work
                    import importlib
                    import altimate_engine.credential_store as mod

                    mod._keyring_cache = True
                    result = mod.store_credential("myconn", "password", "s3cret")
                    assert result is True


class TestGetCredential:
    def test_returns_none_when_no_keyring(self):
        with patch("altimate_engine.credential_store._keyring_available", return_value=False):
            assert get_credential("test", "password") is None


class TestDeleteAllCredentials:
    def test_no_op_when_no_keyring(self):
        with patch("altimate_engine.credential_store._keyring_available", return_value=False):
            delete_all_credentials("test")  # Should not raise


class TestResolveConfig:
    def test_returns_copy_with_no_keyring(self):
        config = {"type": "postgres", "host": "localhost", "password": "plaintext"}
        with patch("altimate_engine.credential_store._keyring_available", return_value=False):
            result = resolve_config("test", config)
            assert result == config
            assert result is not config  # Must be a copy

    def test_fills_none_from_keyring(self):
        config = {"type": "postgres", "host": "localhost", "password": None}
        with patch("altimate_engine.credential_store.get_credential") as mock_get:
            mock_get.return_value = "from_keyring"
            result = resolve_config("test", config)
            assert result["password"] == "from_keyring"
            mock_get.assert_any_call("test", "password")

    def test_preserves_plaintext_values(self):
        config = {"type": "postgres", "password": "plaintext_pass"}
        with patch("altimate_engine.credential_store.get_credential") as mock_get:
            mock_get.return_value = "from_keyring"
            result = resolve_config("test", config)
            assert result["password"] == "plaintext_pass"

    def test_fills_missing_fields_from_keyring(self):
        config = {"type": "postgres", "host": "localhost"}
        with patch("altimate_engine.credential_store.get_credential") as mock_get:
            mock_get.side_effect = lambda name, field: "secret" if field == "password" else None
            result = resolve_config("test", config)
            assert result.get("password") == "secret"  # Missing field → get() returns None → triggers keyring lookup

    def test_sensitive_fields_complete(self):
        assert "password" in SENSITIVE_FIELDS
        assert "private_key_passphrase" in SENSITIVE_FIELDS
        assert "access_token" in SENSITIVE_FIELDS
        assert "ssh_password" in SENSITIVE_FIELDS
        assert "connection_string" in SENSITIVE_FIELDS


class TestSaveConnection:
    def test_saves_to_global_path(self, tmp_path):
        config_path = str(tmp_path / "connections.json")
        config = {"type": "postgres", "host": "localhost", "password": "secret"}

        with patch("altimate_engine.credential_store.store_credential", return_value=False):
            result = save_connection("mydb", config, config_path)

        assert result["type"] == "postgres"
        assert result["host"] == "localhost"
        assert result["password"] is None  # Sensitive field set to None

        with open(config_path) as f:
            saved = json.load(f)
        assert saved["mydb"]["password"] is None

    def test_preserves_existing_connections(self, tmp_path):
        config_path = str(tmp_path / "connections.json")
        existing = {"other_db": {"type": "duckdb"}}
        with open(config_path, "w") as f:
            json.dump(existing, f)

        config = {"type": "postgres", "host": "localhost"}
        with patch("altimate_engine.credential_store.store_credential", return_value=False):
            save_connection("new_db", config, config_path)

        with open(config_path) as f:
            saved = json.load(f)
        assert "other_db" in saved
        assert "new_db" in saved


class TestRemoveConnection:
    def test_removes_existing(self, tmp_path):
        config_path = str(tmp_path / "connections.json")
        existing = {"mydb": {"type": "postgres"}, "other": {"type": "duckdb"}}
        with open(config_path, "w") as f:
            json.dump(existing, f)

        with patch("altimate_engine.credential_store.delete_all_credentials"):
            result = remove_connection("mydb", config_path)

        assert result is True
        with open(config_path) as f:
            saved = json.load(f)
        assert "mydb" not in saved
        assert "other" in saved

    def test_returns_false_for_missing(self, tmp_path):
        config_path = str(tmp_path / "connections.json")
        with open(config_path, "w") as f:
            json.dump({}, f)

        result = remove_connection("nonexistent", config_path)
        assert result is False

    def test_returns_false_for_no_file(self, tmp_path):
        config_path = str(tmp_path / "nonexistent.json")
        result = remove_connection("test", config_path)
        assert result is False
