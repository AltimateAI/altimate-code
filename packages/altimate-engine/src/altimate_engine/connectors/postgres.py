from __future__ import annotations

from typing import Any

from altimate_engine.connectors.base import Connector


class PostgresConnector(Connector):
    def __init__(
        self,
        host: str = "localhost",
        port: int = 5432,
        database: str = "postgres",
        user: str | None = None,
        password: str | None = None,
        connection_string: str | None = None,
        **kwargs,
    ):
        self.connection_string = connection_string
        self.host = host
        self.port = port
        self.database = database
        self.user = user
        self.password = password
        self.kwargs = kwargs
        self._conn = None

    def connect(self) -> Any:
        try:
            import psycopg2
        except ImportError:
            raise ImportError(
                "psycopg2 not installed. Install with: pip install altimate-engine[warehouses]"
            )

        if self.connection_string:
            self._conn = psycopg2.connect(self.connection_string)
        else:
            self._conn = psycopg2.connect(
                host=self.host,
                port=self.port,
                database=self.database,
                user=self.user,
                password=self.password,
                **self.kwargs,
            )
        return self._conn

    def _ensure_conn(self):
        if self._conn is None:
            self.connect()
        return self._conn

    def execute(self, sql: str, params: tuple | list | None = None, limit: int = 1000) -> list[dict[str, Any]]:
        conn = self._ensure_conn()
        cur = conn.cursor()
        cur.execute(sql, params)

        if cur.description is None:
            conn.commit()
            return []

        columns = [desc[0] for desc in cur.description]
        rows = cur.fetchmany(limit)
        result = [dict(zip(columns, row)) for row in rows]
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
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = %s AND table_name = %s",
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
        """Set PostgreSQL session statement timeout.

        Args:
            timeout_ms: Maximum query execution time in milliseconds.
        """
        conn = self._ensure_conn()
        cur = conn.cursor()
        cur.execute(f"SET statement_timeout = {int(timeout_ms)}")
        conn.commit()
        cur.close()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None
