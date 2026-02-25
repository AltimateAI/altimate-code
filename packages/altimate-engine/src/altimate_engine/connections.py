from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from altimate_engine.connectors.base import Connector


class ConnectionRegistry:
    _connections: dict[str, dict[str, Any]] = {}
    _loaded: bool = False

    @classmethod
    def load(cls) -> None:
        if cls._loaded:
            return

        global_config = Path.home() / ".altimate-code" / "connections.json"
        if global_config.exists():
            with open(global_config) as f:
                cls._connections.update(json.load(f))

        project_config = Path.cwd() / ".altimate-code" / "connections.json"
        if project_config.exists():
            with open(project_config) as f:
                cls._connections.update(json.load(f))

        for key, value in os.environ.items():
            if key.startswith("ALTIMATE_CODE_CONN_"):
                name = key[len("ALTIMATE_CODE_CONN_") :].lower()
                try:
                    cls._connections[name] = json.loads(value)
                except json.JSONDecodeError:
                    pass

        cls._loaded = True

    @classmethod
    def get(cls, name: str) -> Connector:
        cls.load()

        if name not in cls._connections:
            raise ValueError(f"Connection '{name}' not found in registry")

        config = cls._connections[name]
        dialect = config.get("type", "duckdb")

        if dialect == "duckdb":
            from altimate_engine.connectors.duckdb import DuckDBConnector

            return DuckDBConnector(
                path=config.get("path", ":memory:"),
                **{k: v for k, v in config.items() if k not in ("type", "path")},
            )
        elif dialect == "postgres":
            from altimate_engine.connectors.postgres import PostgresConnector

            return PostgresConnector(
                connection_string=config.get("connection_string", ""),
                **{
                    k: v
                    for k, v in config.items()
                    if k not in ("type", "connection_string")
                },
            )
        elif dialect == "snowflake":
            from altimate_engine.connectors.snowflake import SnowflakeConnector

            _snowflake_keys = {
                "type", "account", "user", "password", "private_key_path",
                "private_key_passphrase", "warehouse", "database", "schema", "role",
            }
            return SnowflakeConnector(
                account=config.get("account", ""),
                user=config.get("user", ""),
                password=config.get("password"),
                private_key_path=config.get("private_key_path"),
                private_key_passphrase=config.get("private_key_passphrase"),
                warehouse=config.get("warehouse"),
                database=config.get("database"),
                schema=config.get("schema"),
                role=config.get("role"),
                **{k: v for k, v in config.items() if k not in _snowflake_keys},
            )
        else:
            raise ValueError(f"Unsupported connector type: {dialect}")

    @classmethod
    def list(cls) -> list[dict[str, Any]]:
        cls.load()
        return [
            {"name": name, "type": config.get("type", "unknown")}
            for name, config in cls._connections.items()
        ]

    @classmethod
    def test(cls, name: str) -> dict[str, Any]:
        try:
            connector = cls.get(name)
            connector.connect()
            connector.execute("SELECT 1")
            connector.close()
            return {"connected": True, "error": None}
        except Exception as e:
            return {"connected": False, "error": str(e)}

