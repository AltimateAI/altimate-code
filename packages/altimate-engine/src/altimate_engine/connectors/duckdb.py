"""DuckDB connector for embedded OLAP queries."""

from __future__ import annotations

from typing import Any

from altimate_engine.connectors.base import Connector


class DuckDBConnector(Connector):
    """DuckDB connector - embedded, zero-config OLAP database."""

    def __init__(self, path: str = ":memory:", **kwargs):
        """Initialize DuckDB connector.

        Args:
            path: Database path (default: in-memory)
            **kwargs: Additional options passed to duckdb.connect
        """
        self.path = path
        self.options = kwargs
        self._conn = None

    def connect(self) -> Any:
        """Connect to DuckDB."""
        import duckdb

        self._conn = duckdb.connect(self.path, **self.options)
        return self._conn

    def _ensure_connected(self) -> Any:
        """Ensure connection is established."""
        if self._conn is None:
            self.connect()
        return self._conn

    def execute(self, sql: str, params: tuple | list | None = None, limit: int = 1000) -> list[dict[str, Any]]:
        """Execute SQL and return results as list of dicts."""
        conn = self._ensure_connected()
        if params:
            result = conn.execute(sql, params)
        else:
            result = conn.execute(sql)

        if result.description is None:
            return []

        columns = [desc[0] for desc in result.description]
        rows = result.fetchmany(limit)

        return [dict(zip(columns, row)) for row in rows]

    def list_schemas(self) -> list[str]:
        """List all schemas."""
        rows = self.execute(
            "SELECT schema_name FROM information_schema.schemata "
            "WHERE schema_name NOT IN ('information_schema', 'pg_catalog') "
            "ORDER BY schema_name"
        )
        return [row["schema_name"] for row in rows]

    def list_tables(self, schema: str) -> list[dict[str, Any]]:
        """List tables in a schema."""
        rows = self.execute(
            "SELECT table_name as name, table_type as type "
            "FROM information_schema.tables "
            "WHERE table_schema = ? "
            "ORDER BY table_name",
            (schema,),
            limit=10000,
        )
        return rows

    def describe_table(self, schema: str, table: str) -> list[dict[str, Any]]:
        """Describe columns of a table."""
        rows = self.execute(
            "SELECT column_name as name, data_type, "
            "CASE WHEN is_nullable = 'YES' THEN 1 ELSE 0 END as nullable "
            "FROM information_schema.columns "
            "WHERE table_schema = ? AND table_name = ? "
            "ORDER BY ordinal_position",
            (schema, table),
            limit=1000,
        )
        return rows

    def close(self) -> None:
        """Close the connection."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None
