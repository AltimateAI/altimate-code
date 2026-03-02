"""Parse dbt profiles.yml and map to altimate-code connection configs."""

from __future__ import annotations

from pathlib import Path
from typing import Any


# Maps dbt adapter types to altimate-code connector types
_ADAPTER_MAP = {
    "snowflake": "snowflake",
    "bigquery": "bigquery",
    "databricks": "databricks",
    "postgres": "postgres",
    "redshift": "redshift",
    "mysql": "mysql",
    "sqlserver": "sqlserver",
    "duckdb": "duckdb",
}

# Maps dbt config keys to altimate-code connector config keys per adapter
_KEY_MAP: dict[str, dict[str, str]] = {
    "snowflake": {
        "account": "account",
        "user": "user",
        "password": "password",
        "private_key_path": "private_key_path",
        "private_key_passphrase": "private_key_passphrase",
        "warehouse": "warehouse",
        "database": "database",
        "schema": "schema",
        "role": "role",
    },
    "bigquery": {
        "project": "project",
        "keyfile": "credentials_path",
        "location": "location",
        "dataset": "dataset",
    },
    "databricks": {
        "host": "server_hostname",
        "http_path": "http_path",
        "token": "access_token",
        "catalog": "catalog",
        "schema": "schema",
    },
    "postgres": {
        "host": "host",
        "port": "port",
        "dbname": "database",
        "user": "user",
        "password": "password",
    },
    "redshift": {
        "host": "host",
        "port": "port",
        "dbname": "database",
        "user": "user",
        "password": "password",
    },
    "mysql": {
        "server": "host",
        "port": "port",
        "schema": "database",
        "username": "user",
        "password": "password",
    },
    "duckdb": {
        "path": "path",
    },
}


def parse_profiles_yml(
    path: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Parse dbt profiles.yml and map to altimate-code connection configs.

    Args:
        path: Path to profiles.yml. Defaults to ~/.dbt/profiles.yml.

    Returns:
        Dict mapping profile names to altimate-code connection configs.
        E.g. {"dbt_my_snowflake_dev": {"type": "snowflake", "account": "...", ...}}
    """
    try:
        import yaml
    except ImportError:
        return {}

    profiles_path = Path(path) if path else Path.home() / ".dbt" / "profiles.yml"
    if not profiles_path.exists():
        return {}

    try:
        with open(profiles_path) as f:
            raw = yaml.safe_load(f)
    except Exception:
        return {}

    if not isinstance(raw, dict):
        return {}

    result: dict[str, dict[str, Any]] = {}

    for profile_name, profile_data in raw.items():
        if not isinstance(profile_data, dict):
            continue

        # Skip dbt config sections
        if profile_name in ("config",):
            continue

        outputs = profile_data.get("outputs", {})
        if not isinstance(outputs, dict):
            continue

        for output_name, output_config in outputs.items():
            if not isinstance(output_config, dict):
                continue

            adapter_type = output_config.get("type", "")
            connector_type = _ADAPTER_MAP.get(adapter_type)
            if not connector_type:
                continue

            conn_config = _map_config(connector_type, output_config)
            if conn_config is None:
                continue

            # Name format: dbt_{profile}_{output}
            conn_name = f"dbt_{profile_name}_{output_name}"
            result[conn_name] = conn_config

    return result


def _map_config(connector_type: str, dbt_config: dict[str, Any]) -> dict[str, Any] | None:
    """Map a dbt output config to an altimate-code connection config."""
    key_map = _KEY_MAP.get(connector_type, {})
    if not key_map:
        return None

    conn: dict[str, Any] = {"type": connector_type}
    for dbt_key, altimate_key in key_map.items():
        value = dbt_config.get(dbt_key)
        if value is not None:
            conn[altimate_key] = value

    return conn


def discover_dbt_connections(
    path: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Discover dbt profiles and return as connection configs.

    Convenience wrapper that silently returns empty dict on any error.
    Safe to call during CLI startup.
    """
    try:
        return parse_profiles_yml(path)
    except Exception:
        return {}
