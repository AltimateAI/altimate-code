"""Databricks warehouse connector with PAT authentication and Unity Catalog support."""

from __future__ import annotations

from typing import Any

from altimate_engine.connectors.base import Connector


class DatabricksConnector(Connector):
    """Databricks connector using databricks-sql-connector SDK.

    Supports:
    - Personal Access Token (PAT) authentication
    - Unity Catalog for metadata (with fallback to SHOW commands)
    """

    def __init__(
        self,
        server_hostname: str,
        http_path: str,
        access_token: str | None = None,
        catalog: str | None = None,
        schema: str | None = None,
        **kwargs,
    ):
        self.server_hostname = server_hostname
        self.http_path = http_path
        self.access_token = access_token
        self.catalog = catalog
        self.schema = schema
        self.kwargs = kwargs
        self._conn = None
        self._timeout_ms: int | None = None
        self._unity_catalog_available: bool | None = None

    def connect(self) -> Any:
        try:
            from databricks import sql
        except ImportError:
            raise ImportError(
                "databricks-sql-connector not installed. Install with: pip install altimate-engine[warehouses]"
            )

        if not self.access_token:
            raise ValueError(
                "Databricks access_token is required. "
                "Generate a PAT from Databricks: User Settings > Developer > Access Tokens."
            )

        connect_params = {
            "server_hostname": self.server_hostname,
            "http_path": self.http_path,
            "access_token": self.access_token,
        }

        if self.catalog:
            connect_params["catalog"] = self.catalog
        if self.schema:
            connect_params["schema"] = self.schema

        try:
            self._conn = sql.connect(**connect_params)
        except Exception as e:
            error_msg = str(e).lower()
            if "token" in error_msg or "auth" in error_msg:
                raise ValueError(
                    f"Databricks authentication failed. Check your access_token. Error: {e}"
                )
            raise

        return self._conn

    def _ensure_conn(self):
        if self._conn is None:
            self.connect()
        return self._conn

    def _check_unity_catalog(self) -> bool:
        """Check if Unity Catalog is available."""
        if self._unity_catalog_available is not None:
            return self._unity_catalog_available

        try:
            conn = self._ensure_conn()
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM system.query.history LIMIT 1")
            cur.fetchall()
            cur.close()
            self._unity_catalog_available = True
        except Exception:
            self._unity_catalog_available = False

        return self._unity_catalog_available

    def execute(
        self, sql: str, params: tuple | list | None = None, limit: int = 1000
    ) -> list[dict[str, Any]]:
        conn = self._ensure_conn()
        cur = conn.cursor()

        if self._timeout_ms:
            timeout_sec = max(1, self._timeout_ms // 1000)
            cur.execute(f"SET spark.databricks.queryTimeout = {timeout_sec}")

        try:
            if params:
                cur.execute(sql, params)
            else:
                cur.execute(sql)

            if cur.description is None:
                cur.close()
                return []

            columns = [desc[0] for desc in cur.description]
            rows = cur.fetchmany(limit)
            result = [dict(zip(columns, row)) for row in rows]
            cur.close()
            return result
        except Exception as e:
            cur.close()
            error_msg = str(e).lower()
            if "permission" in error_msg or "access" in error_msg:
                raise PermissionError(
                    f"Databricks permission denied. Ensure you have access to the warehouse "
                    f"and required tables. Error: {e}"
                )
            raise

    def list_schemas(self) -> list[str]:
        if self._check_unity_catalog():
            try:
                rows = self.execute(
                    "SELECT schema_name FROM information_schema.schemata"
                )
                return [row["schema_name"] for row in rows]
            except Exception:
                pass

        rows = self.execute("SHOW SCHEMAS")
        return [row["databaseName"] for row in rows]

    def list_tables(self, schema: str) -> list[dict[str, Any]]:
        if self._check_unity_catalog():
            try:
                rows = self.execute(
                    f"SELECT table_name, table_type FROM information_schema.tables "
                    f"WHERE table_schema = '{schema}'"
                )
                return [
                    {"name": row["table_name"], "type": row.get("table_type", "TABLE")}
                    for row in rows
                ]
            except Exception:
                pass

        rows = self.execute(f"SHOW TABLES IN {schema}")
        return [
            {"name": row["tableName"], "type": row.get("isTemporary", "TABLE")}
            for row in rows
        ]

    def describe_table(self, schema: str, table: str) -> list[dict[str, Any]]:
        if self._check_unity_catalog():
            try:
                rows = self.execute(
                    f"SELECT column_name, data_type, is_nullable "
                    f"FROM information_schema.columns "
                    f"WHERE table_schema = '{schema}' AND table_name = '{table}'"
                )
                return [
                    {
                        "name": row["column_name"],
                        "data_type": row["data_type"],
                        "nullable": row.get("is_nullable", "YES") == "YES",
                    }
                    for row in rows
                ]
            except Exception:
                pass

        rows = self.execute(f"DESCRIBE TABLE {schema}.{table}")
        return [
            {
                "name": row["col_name"],
                "data_type": row["data_type"],
                "nullable": True,
            }
            for row in rows
            if row.get("col_name") and not row["col_name"].startswith("#")
        ]

    def set_statement_timeout(self, timeout_ms: int) -> None:
        self._timeout_ms = timeout_ms

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None
