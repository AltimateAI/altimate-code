from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from altimate_engine.connectors.base import Connector
from altimate_engine.credential_store import resolve_config
from altimate_engine.ssh_tunnel import start, stop

SSH_FIELDS = {
    "ssh_host",
    "ssh_port",
    "ssh_user",
    "ssh_auth_type",
    "ssh_key_path",
    "ssh_password",
}


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

        config = dict(cls._connections[name])
        config = resolve_config(name, config)

        ssh_host = config.get("ssh_host")
        if ssh_host:
            if config.get("connection_string"):
                raise ValueError(
                    "SSH tunneling requires explicit host/port — "
                    "cannot be used with connection_string"
                )
            ssh_config = {
                k: config.pop(k) for k in list(config.keys()) if k in SSH_FIELDS
            }
            local_port = start(
                name=name,
                ssh_host=ssh_config.get("ssh_host", ""),
                remote_host=config.get("host", "localhost"),
                remote_port=config.get("port", 5432),
                ssh_port=ssh_config.get("ssh_port", 22),
                ssh_user=ssh_config.get("ssh_user"),
                ssh_auth_type=ssh_config.get("ssh_auth_type", "key"),
                ssh_key_path=ssh_config.get("ssh_key_path"),
                ssh_password=ssh_config.get("ssh_password"),
            )
            config["host"] = "127.0.0.1"
            config["port"] = local_port

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
                "type",
                "account",
                "user",
                "password",
                "private_key_path",
                "private_key_passphrase",
                "warehouse",
                "database",
                "schema",
                "role",
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
        elif dialect == "bigquery":
            from altimate_engine.connectors.bigquery import BigQueryConnector

            _bigquery_keys = {"type", "project", "credentials_path", "location"}
            return BigQueryConnector(
                project=config.get("project", ""),
                credentials_path=config.get("credentials_path"),
                location=config.get("location", "US"),
                **{k: v for k, v in config.items() if k not in _bigquery_keys},
            )
        elif dialect == "databricks":
            from altimate_engine.connectors.databricks import DatabricksConnector

            _databricks_keys = {
                "type",
                "server_hostname",
                "http_path",
                "access_token",
                "catalog",
                "schema",
            }
            return DatabricksConnector(
                server_hostname=config.get("server_hostname", ""),
                http_path=config.get("http_path", ""),
                access_token=config.get("access_token"),
                catalog=config.get("catalog"),
                schema=config.get("schema"),
                **{k: v for k, v in config.items() if k not in _databricks_keys},
            )
        elif dialect == "redshift":
            from altimate_engine.connectors.redshift import RedshiftConnector

            _redshift_keys = {
                "type",
                "host",
                "port",
                "database",
                "user",
                "password",
                "connection_string",
                "iam_role",
                "region",
                "cluster_identifier",
            }
            return RedshiftConnector(
                host=config.get("host", ""),
                port=config.get("port", 5439),
                database=config.get("database", "dev"),
                user=config.get("user"),
                password=config.get("password"),
                connection_string=config.get("connection_string"),
                iam_role=config.get("iam_role"),
                region=config.get("region"),
                cluster_identifier=config.get("cluster_identifier"),
                **{k: v for k, v in config.items() if k not in _redshift_keys},
            )
        elif dialect == "mysql":
            from altimate_engine.connectors.mysql import MySQLConnector

            _mysql_keys = {
                "type",
                "host",
                "port",
                "database",
                "user",
                "password",
                "ssl_ca",
                "ssl_cert",
                "ssl_key",
            }
            return MySQLConnector(
                host=config.get("host", "localhost"),
                port=config.get("port", 3306),
                database=config.get("database"),
                user=config.get("user"),
                password=config.get("password"),
                ssl_ca=config.get("ssl_ca"),
                ssl_cert=config.get("ssl_cert"),
                ssl_key=config.get("ssl_key"),
                **{k: v for k, v in config.items() if k not in _mysql_keys},
            )
        elif dialect == "sqlserver":
            from altimate_engine.connectors.sqlserver import SQLServerConnector

            _sqlserver_keys = {
                "type",
                "host",
                "port",
                "database",
                "user",
                "password",
                "driver",
                "azure_auth",
                "trust_server_certificate",
            }
            return SQLServerConnector(
                host=config.get("host", "localhost"),
                port=config.get("port", 1433),
                database=config.get("database"),
                user=config.get("user"),
                password=config.get("password"),
                driver=config.get("driver", "ODBC Driver 18 for SQL Server"),
                azure_auth=config.get("azure_auth", False),
                trust_server_certificate=config.get("trust_server_certificate", False),
                **{k: v for k, v in config.items() if k not in _sqlserver_keys},
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
        finally:
            stop(name)

    @classmethod
    def add(cls, name: str, config: dict[str, Any]) -> dict[str, Any]:
        from altimate_engine.credential_store import save_connection

        result = save_connection(name, config)
        cls._loaded = False
        return result

    @classmethod
    def remove(cls, name: str) -> bool:
        from altimate_engine.credential_store import remove_connection

        result = remove_connection(name)
        cls._loaded = False
        return result

    @classmethod
    def reload(cls) -> None:
        cls._loaded = False
        cls._connections.clear()
