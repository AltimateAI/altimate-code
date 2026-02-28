"""Tests for ssh_tunnel module."""

from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest

import altimate_engine.ssh_tunnel as tunnel_mod


@pytest.fixture(autouse=True)
def reset_tunnel_state():
    """Reset tunnel module state before each test."""
    tunnel_mod._tunnel_registry.clear()
    tunnel_mod._initialized = False
    yield
    tunnel_mod._tunnel_registry.clear()
    tunnel_mod._initialized = False


class TestStart:
    def test_raises_import_error_when_sshtunnel_missing(self):
        with patch.dict("sys.modules", {"sshtunnel": None}):
            with patch("builtins.__import__", side_effect=ImportError("No module named 'sshtunnel'")):
                with pytest.raises(ImportError, match="sshtunnel not installed"):
                    tunnel_mod.start(
                        name="test",
                        ssh_host="bastion.example.com",
                        remote_host="10.0.1.50",
                        remote_port=5432,
                    )

    def test_starts_key_based_tunnel(self):
        mock_tunnel = MagicMock()
        mock_tunnel.local_bind_port = 54321

        mock_forwarder = MagicMock(return_value=mock_tunnel)
        mock_sshtunnel = MagicMock()
        mock_sshtunnel.SSHTunnelForwarder = mock_forwarder

        with patch.dict("sys.modules", {"sshtunnel": mock_sshtunnel}):
            port = tunnel_mod.start(
                name="myconn",
                ssh_host="bastion.example.com",
                remote_host="10.0.1.50",
                remote_port=5432,
                ssh_user="deploy",
                ssh_auth_type="key",
                ssh_key_path="/home/user/.ssh/id_rsa",
            )

        assert port == 54321
        mock_tunnel.start.assert_called_once()
        assert "myconn" in tunnel_mod._tunnel_registry
        mock_forwarder.assert_called_once_with(
            ("bastion.example.com", 22),
            ssh_username="deploy",
            ssh_pkey="/home/user/.ssh/id_rsa",
            remote_bind_address=("10.0.1.50", 5432),
        )

    def test_starts_password_based_tunnel(self):
        mock_tunnel = MagicMock()
        mock_tunnel.local_bind_port = 54322

        mock_forwarder = MagicMock(return_value=mock_tunnel)
        mock_sshtunnel = MagicMock()
        mock_sshtunnel.SSHTunnelForwarder = mock_forwarder

        with patch.dict("sys.modules", {"sshtunnel": mock_sshtunnel}):
            port = tunnel_mod.start(
                name="pw_conn",
                ssh_host="bastion.example.com",
                remote_host="10.0.1.50",
                remote_port=5432,
                ssh_user="deploy",
                ssh_auth_type="password",
                ssh_password="s3cret",
            )

        assert port == 54322
        mock_forwarder.assert_called_once_with(
            ("bastion.example.com", 22),
            ssh_username="deploy",
            ssh_password="s3cret",
            remote_bind_address=("10.0.1.50", 5432),
        )

    def test_reuses_existing_tunnel(self):
        mock_tunnel = MagicMock()
        mock_tunnel.local_bind_port = 54321
        tunnel_mod._tunnel_registry["existing"] = mock_tunnel

        port = tunnel_mod.start(
            name="existing",
            ssh_host="bastion.example.com",
            remote_host="10.0.1.50",
            remote_port=5432,
        )

        assert port == 54321
        # start() should NOT have been called again
        mock_tunnel.start.assert_not_called()

    def test_custom_ssh_port(self):
        mock_tunnel = MagicMock()
        mock_tunnel.local_bind_port = 54323

        mock_forwarder = MagicMock(return_value=mock_tunnel)
        mock_sshtunnel = MagicMock()
        mock_sshtunnel.SSHTunnelForwarder = mock_forwarder

        with patch.dict("sys.modules", {"sshtunnel": mock_sshtunnel}):
            tunnel_mod.start(
                name="custom_port",
                ssh_host="bastion.example.com",
                remote_host="10.0.1.50",
                remote_port=5432,
                ssh_port=2222,
                ssh_auth_type="key",
            )

        mock_forwarder.assert_called_once_with(
            ("bastion.example.com", 2222),
            ssh_username=None,
            ssh_pkey=None,
            remote_bind_address=("10.0.1.50", 5432),
        )


class TestStop:
    def test_stops_existing_tunnel(self):
        mock_tunnel = MagicMock()
        tunnel_mod._tunnel_registry["myconn"] = mock_tunnel

        tunnel_mod.stop("myconn")

        mock_tunnel.stop.assert_called_once()
        assert "myconn" not in tunnel_mod._tunnel_registry

    def test_no_op_for_missing_tunnel(self):
        tunnel_mod.stop("nonexistent")  # Should not raise


class TestStopAll:
    def test_stops_all_tunnels(self):
        mock1 = MagicMock()
        mock2 = MagicMock()
        tunnel_mod._tunnel_registry["conn1"] = mock1
        tunnel_mod._tunnel_registry["conn2"] = mock2

        tunnel_mod.stop_all()

        mock1.stop.assert_called_once()
        mock2.stop.assert_called_once()
        assert len(tunnel_mod._tunnel_registry) == 0

    def test_no_op_when_empty(self):
        tunnel_mod.stop_all()  # Should not raise


class TestIsActive:
    def test_returns_true_for_active(self):
        tunnel_mod._tunnel_registry["active"] = MagicMock()
        assert tunnel_mod.is_active("active") is True

    def test_returns_false_for_inactive(self):
        assert tunnel_mod.is_active("nonexistent") is False


class TestAtexitRegistration:
    def test_registers_atexit_once(self):
        with patch("atexit.register") as mock_register:
            tunnel_mod._initialized = False
            tunnel_mod._register_atexit()
            tunnel_mod._register_atexit()  # Second call should be no-op

            mock_register.assert_called_once_with(tunnel_mod.stop_all)
            assert tunnel_mod._initialized is True
