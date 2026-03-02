"""Snowflake warehouse connector with password and key-pair authentication."""

from __future__ import annotations

from typing import Any

from altimate_engine.connectors.base import Connector


class SnowflakeConnector(Connector):
    def __init__(
        self,
        account: str,
        user: str,
        password: str | None = None,
        private_key_path: str | None = None,
        private_key_passphrase: str | None = None,
        warehouse: str | None = None,
        database: str | None = None,
        schema: str | None = None,
        role: str | None = None,
        connection_string: str | None = None,
        **kwargs,
    ):
        self.account = account
        self.user = user
        self.password = password
        self.private_key_path = private_key_path
        self.private_key_passphrase = private_key_passphrase
        self.warehouse = warehouse
        self.database = database
        self.schema = schema
        self.role = role
        self.connection_string = connection_string
        self.kwargs = kwargs
        self._conn = None

    def _load_private_key(self) -> bytes:
        try:
            from cryptography.hazmat.backends import default_backend
            from cryptography.hazmat.primitives import serialization
        except ImportError:
            raise ImportError(
                "cryptography not installed. Install with: pip install altimate-engine[warehouses]"
            )

        with open(self.private_key_path, "rb") as f:
            p_key = serialization.load_pem_private_key(
                f.read(),
                password=self.private_key_passphrase.encode()
                if self.private_key_passphrase
                else None,
                backend=default_backend(),
            )

        return p_key.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )

    def connect(self) -> Any:
        try:
            import snowflake.connector
        except ImportError:
            raise ImportError(
                "snowflake-connector-python not installed. Install with: pip install altimate-engine[warehouses]"
            )

        connect_params: dict[str, Any] = {
            "account": self.account,
            "user": self.user,
        }

        if self.private_key_path:
            connect_params["private_key"] = self._load_private_key()
        else:
            connect_params["password"] = self.password

        if self.warehouse:
            connect_params["warehouse"] = self.warehouse
        if self.database:
            connect_params["database"] = self.database
        if self.schema:
            connect_params["schema"] = self.schema
        if self.role:
            connect_params["role"] = self.role

        connect_params.update(self.kwargs)

        self._conn = snowflake.connector.connect(**connect_params)
        return self._conn

    def _ensure_conn(self):
        if self._conn is None:
            self.connect()
        return self._conn

    def execute(self, sql: str, params: tuple | list | None = None, limit: int = 1000) -> list[dict[str, Any]]:
        conn = self._ensure_conn()
        cur = conn.cursor()
        if params:
            cur.execute(sql, params)
        else:
            cur.execute(sql)

        if cur.description is None:
            return []

        columns = [desc[0] for desc in cur.description]
        rows = cur.fetchmany(limit)
        result = [dict(zip(columns, row)) for row in rows]
        cur.close()
        return result

    def list_schemas(self) -> list[str]:
        rows = self.execute("SHOW SCHEMAS")
        return [row["name"] for row in rows]

    def list_tables(self, schema: str) -> list[dict[str, Any]]:
        rows = self.execute(f'SHOW TABLES IN SCHEMA "{schema}"')
        return [{"name": row["name"], "type": row.get("kind", "TABLE")} for row in rows]

    def describe_table(self, schema: str, table: str) -> list[dict[str, Any]]:
        rows = self.execute(f'DESCRIBE TABLE "{schema}"."{table}"')
        return [
            {
                "name": row["name"],
                "data_type": row["type"],
                "nullable": row.get("null?", "Y") == "Y",
            }
            for row in rows
        ]

    def set_statement_timeout(self, timeout_ms: int) -> None:
        """Set Snowflake session statement timeout.

        Args:
            timeout_ms: Maximum query execution time in milliseconds.
        """
        timeout_sec = max(1, timeout_ms // 1000)
        conn = self._ensure_conn()
        cur = conn.cursor()
        cur.execute(f"ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = {timeout_sec}")
        cur.close()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None
