"""SQL Server connector with ODBC and pymssql fallback."""

from __future__ import annotations

from typing import Any

from altimate_engine.connectors.base import Connector


class SQLServerConnector(Connector):
    """SQL Server connector using pyodbc (primary) or pymssql (fallback).

    Supports:
    - Password authentication
    - Azure AD authentication via azure-identity
    - pyodbc with ODBC Driver 18 (primary)
    - pymssql as pure-Python fallback
    """

    def __init__(
        self,
        host: str = "localhost",
        port: int = 1433,
        database: str | None = None,
        user: str | None = None,
        password: str | None = None,
        driver: str = "ODBC Driver 18 for SQL Server",
        azure_auth: bool = False,
        trust_server_certificate: bool = False,
        **kwargs,
    ):
        self.host = host
        self.port = port
        self.database = database
        self.user = user
        self.password = password
        self.driver = driver
        self.azure_auth = azure_auth
        self.trust_server_certificate = trust_server_certificate
        self.kwargs = kwargs
        self._conn = None
        self._backend: str | None = None  # "pyodbc" or "pymssql"

    def connect(self) -> Any:
        # Try pyodbc first, fall back to pymssql
        try:
            return self._connect_pyodbc()
        except ImportError:
            pass
        except Exception as e:
            # pyodbc is installed but ODBC driver is missing
            if "driver" in str(e).lower():
                try:
                    return self._connect_pymssql()
                except ImportError:
                    raise ImportError(
                        f"ODBC driver '{self.driver}' not found and pymssql not installed.\n"
                        f"Option 1: Install ODBC driver:\n"
                        f"  macOS:  brew install msodbcsql18\n"
                        f"  Linux:  sudo apt-get install msodbcsql18\n"
                        f"Option 2: Install pymssql: pip install pymssql"
                    )
            raise

        # If pyodbc import failed, try pymssql
        try:
            return self._connect_pymssql()
        except ImportError:
            raise ImportError(
                "Neither pyodbc nor pymssql is installed. Install one of:\n"
                "  pip install pyodbc   (requires ODBC driver)\n"
                "  pip install pymssql  (pure Python, no driver needed)"
            )

    def _connect_pyodbc(self) -> Any:
        import pyodbc

        parts = [
            f"DRIVER={{{self.driver}}}",
            f"SERVER={self.host},{self.port}",
        ]
        if self.database:
            parts.append(f"DATABASE={self.database}")

        if self.azure_auth:
            try:
                from azure.identity import DefaultAzureCredential

                credential = DefaultAzureCredential()
                token = credential.get_token("https://database.windows.net/.default")
                parts.append(f"AccessToken={token.token}")
            except ImportError:
                raise ImportError(
                    "azure-identity not installed. Install with: pip install azure-identity"
                )
        else:
            if self.user:
                parts.append(f"UID={self.user}")
            if self.password:
                parts.append(f"PWD={self.password}")

        if self.trust_server_certificate:
            parts.append("TrustServerCertificate=yes")

        conn_str = ";".join(parts)
        self._conn = pyodbc.connect(conn_str)
        self._backend = "pyodbc"
        return self._conn

    def _connect_pymssql(self) -> Any:
        import pymssql

        self._conn = pymssql.connect(
            server=self.host,
            port=self.port,
            user=self.user,
            password=self.password,
            database=self.database or "",
            as_dict=True,
        )
        self._backend = "pymssql"
        return self._conn

    def _ensure_conn(self):
        if self._conn is None:
            self.connect()
        return self._conn

    def execute(
        self, sql: str, params: tuple | list | None = None, limit: int = 1000
    ) -> list[dict[str, Any]]:
        conn = self._ensure_conn()
        cur = conn.cursor()

        if params:
            cur.execute(sql, params)
        else:
            cur.execute(sql)

        if cur.description is None:
            conn.commit()
            cur.close()
            return []

        columns = [desc[0] for desc in cur.description]
        rows = cur.fetchmany(limit)

        if self._backend == "pymssql":
            # pymssql with as_dict=True returns dicts directly
            result = [
                dict(row) if isinstance(row, dict) else dict(zip(columns, row))
                for row in rows
            ]
        else:
            result = [dict(zip(columns, row)) for row in rows]

        cur.close()
        return result

    def list_schemas(self) -> list[str]:
        rows = self.execute(
            "SELECT schema_name FROM information_schema.schemata "
            "WHERE schema_name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')"
        )
        return [row["schema_name"] for row in rows]

    def list_tables(self, schema: str) -> list[dict[str, Any]]:
        rows = self.execute(
            "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ?",
            (schema,),
        )
        return [{"name": row["table_name"], "type": row["table_type"]} for row in rows]

    def describe_table(self, schema: str, table: str) -> list[dict[str, Any]]:
        rows = self.execute(
            "SELECT column_name, data_type, is_nullable "
            "FROM information_schema.columns "
            "WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
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
        # SQL Server doesn't have a direct session-level statement timeout.
        # Use LOCK_TIMEOUT as a reasonable approximation.
        conn = self._ensure_conn()
        cur = conn.cursor()
        cur.execute(f"SET LOCK_TIMEOUT {int(timeout_ms)}")
        cur.close()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None
