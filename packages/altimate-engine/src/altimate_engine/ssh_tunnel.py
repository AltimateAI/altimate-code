from __future__ import annotations

import atexit
from typing import Any

_tunnel_registry: dict[str, Any] = {}
_initialized = False


def _register_atexit() -> None:
    global _initialized
    if _initialized:
        return
    atexit.register(stop_all)
    _initialized = True


def start(
    name: str,
    ssh_host: str,
    remote_host: str,
    remote_port: int,
    ssh_port: int = 22,
    ssh_user: str | None = None,
    ssh_auth_type: str = "key",
    ssh_key_path: str | None = None,
    ssh_password: str | None = None,
) -> int:
    """Start an SSH tunnel for a connection.
    
    Args:
        name: Connection name (for tracking)
        ssh_host: SSH server hostname
        remote_host: Database host (from SSH server perspective)
        remote_port: Database port
        ssh_port: SSH port (default 22)
        ssh_user: SSH username
        ssh_auth_type: "key" or "password"
        ssh_key_path: Path to SSH private key
        ssh_password: SSH password (if auth_type is "password")
        
    Returns:
        Local port number for the tunnel
        
    Raises:
        ImportError: If sshtunnel not installed
        ValueError: If tunnel already exists for name
    """
    _register_atexit()
    
    if name in _tunnel_registry:
        return _tunnel_registry[name].local_bind_port
    
    try:
        from sshtunnel import SSHTunnelForwarder
    except ImportError:
        raise ImportError(
            "sshtunnel not installed. Install with: pip install altimate-engine[tunneling]"
        )
    
    if ssh_auth_type == "key":
        tunnel = SSHTunnelForwarder(
            (ssh_host, ssh_port),
            ssh_username=ssh_user,
            ssh_pkey=ssh_key_path,
            remote_bind_address=(remote_host, remote_port),
        )
    else:
        tunnel = SSHTunnelForwarder(
            (ssh_host, ssh_port),
            ssh_username=ssh_user,
            ssh_password=ssh_password,
            remote_bind_address=(remote_host, remote_port),
        )
    
    tunnel.start()
    _tunnel_registry[name] = tunnel
    return tunnel.local_bind_port


def stop(name: str) -> None:
    """Stop an SSH tunnel.
    
    Args:
        name: Connection name
    """
    if name in _tunnel_registry:
        _tunnel_registry[name].stop()
        del _tunnel_registry[name]


def stop_all() -> None:
    """Stop all SSH tunnels."""
    for tunnel in _tunnel_registry.values():
        tunnel.stop()
    _tunnel_registry.clear()


def is_active(name: str) -> bool:
    """Check if a tunnel is active.
    
    Args:
        name: Connection name
        
    Returns:
        True if tunnel exists and is active
    """
    return name in _tunnel_registry
