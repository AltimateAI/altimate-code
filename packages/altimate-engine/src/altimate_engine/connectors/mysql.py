"""MySQL warehouse connector with password and SSL authentication."""

from __future__ import annotations

from typing import Any

from altimate_engine.connectors.base import Connector


class MySQLConnector(Connector):
    """MySQL connector using mysql-connector-python SDK.

    Supports:
    - Password authentication
    - SSL connections
    """

    def __init__(
        self,
        host: str = "localhost",
        port: int = 3306,
        database: str | None = None,
        user: str | None = None,
        password: str | None = None,
        ssl_ca: str | None = None,
        ssl_cert: str | None = None,
        ssl_key: str | None = None,
        **kwargs,
    ):
        self.host = host
        self.port = port
        self.database = database
        self.user = user
        self.password = password
        self.ssl_ca = ssl_ca
        self.ssl_cert = ssl_cert
        self.ssl_key = ssl_key
        self.kwargs = kwargs
        self._conn = None

    def connect(self) -> Any:
        try:
            import mysql.connector
        except ImportError:
            raise ImportError(
                "mysql-connector-python not installed. Install with: pip install mysql-connector-python"
            )

        connect_params = {
            "host": self.host,
            "port": self.port,
            "user": self.user,
            "password": self.password,
        }
        if self.database:
            connect_params["database"] = self.database

        # SSL configuration
        if self.ssl_ca:
            connect_params["ssl_ca"] = self.ssl_ca
        if self.ssl_cert:
            connect_params["client_cert"] = self.ssl_cert
        if self.ssl_key:
            connect_params["client_key"] = self.ssl_key

        connect_params.update(self.kwargs)
        self._conn = mysql.connector.connect(**connect_params)
        return self._conn

    def _ensure_conn(self):
        if self._conn is None:
            self.connect()
        return self._conn

    def execute(
        self, sql: str, params: tuple | list | None = None, limit: int = 1000
    ) -> list[dict[str, Any]]:
        conn = self._ensure_conn()
        cur = conn.cursor(dictionary=True)
        cur.execute(sql, params)

        if cur.description is None:
            conn.commit()
            cur.close()
            return []

        rows = cur.fetchmany(limit)
        result = [dict(row) for row in rows]
        cur.close()
        return result

    def list_schemas(self) -> list[str]:
        rows = self.execute("SELECT schema_name FROM information_schema.schemata")
        return [row["schema_name"] for row in rows]

    def list_tables(self, schema: str) -> list[dict[str, Any]]:
        rows = self.execute(
            "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = %s",
            (schema,),
        )
        return [{"name": row["table_name"], "type": row["table_type"]} for row in rows]

    def describe_table(self, schema: str, table: str) -> list[dict[str, Any]]:
        rows = self.execute(
            "SELECT column_name, column_type AS data_type, is_nullable "
            "FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
            (schema, table),
        )
        return [
            {
                "name": row["column_name"],
                "data_type": row["data_type"],
                "nullable": row["is_nullable"] == "YES",
            }
            for row in rows
        ]

    def set_statement_timeout(self, timeout_ms: int) -> None:
        timeout_sec = max(1, timeout_ms // 1000)
        conn = self._ensure_conn()
        cur = conn.cursor()
        cur.execute(f"SET max_execution_time = {timeout_sec * 1000}")
        cur.close()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None
