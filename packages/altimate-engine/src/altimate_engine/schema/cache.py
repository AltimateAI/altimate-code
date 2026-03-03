"""Schema cache — indexes warehouse metadata into SQLite for fast search.

This is altimate-code's answer to Snowflake's Horizon Catalog integration.
While Cortex Code has native catalog access, we build a local schema cache
that pre-indexes all databases/schemas/tables/columns for instant search.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_CREATE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS warehouses (
    name TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    last_indexed TEXT,
    databases_count INTEGER DEFAULT 0,
    schemas_count INTEGER DEFAULT 0,
    tables_count INTEGER DEFAULT 0,
    columns_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tables_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse TEXT NOT NULL,
    database_name TEXT,
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    table_type TEXT DEFAULT 'TABLE',
    row_count INTEGER,
    comment TEXT,
    search_text TEXT NOT NULL,
    UNIQUE(warehouse, database_name, schema_name, table_name)
);

CREATE TABLE IF NOT EXISTS columns_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse TEXT NOT NULL,
    database_name TEXT,
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    data_type TEXT,
    nullable INTEGER DEFAULT 1,
    comment TEXT,
    search_text TEXT NOT NULL,
    UNIQUE(warehouse, database_name, schema_name, table_name, column_name)
);

CREATE INDEX IF NOT EXISTS idx_tables_search ON tables_cache(search_text);
CREATE INDEX IF NOT EXISTS idx_columns_search ON columns_cache(search_text);
CREATE INDEX IF NOT EXISTS idx_tables_warehouse ON tables_cache(warehouse);
CREATE INDEX IF NOT EXISTS idx_columns_warehouse ON columns_cache(warehouse);
CREATE INDEX IF NOT EXISTS idx_columns_table ON columns_cache(warehouse, schema_name, table_name);
"""


def _default_cache_path() -> str:
    cache_dir = Path.home() / ".altimate"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return str(cache_dir / "schema_cache.db")


def _make_search_text(*parts: str | None) -> str:
    """Build a searchable text from parts (lowercased, underscores → spaces)."""
    tokens = []
    for p in parts:
        if p:
            # Add original and underscore-split versions
            tokens.append(p.lower())
            if "_" in p:
                tokens.extend(p.lower().split("_"))
    return " ".join(tokens)


class SchemaCache:
    """SQLite-backed schema metadata cache for fast warehouse search."""

    def __init__(self, db_path: str | None = None):
        self._db_path = db_path or _default_cache_path()
        self._conn = sqlite3.connect(self._db_path)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        cursor = self._conn.cursor()
        cursor.executescript(_CREATE_TABLES_SQL)
        self._conn.commit()

    def index_warehouse(
        self,
        warehouse_name: str,
        warehouse_type: str,
        connector: Any,
    ) -> dict[str, Any]:
        """Crawl a warehouse and index all schemas/tables/columns.

        Args:
            warehouse_name: Registry name of the warehouse connection
            warehouse_type: Connector type (snowflake, postgres, duckdb)
            connector: A connected Connector instance

        Returns:
            Summary dict with counts of indexed objects
        """
        now = datetime.now(timezone.utc).isoformat()

        # Clear existing data for this warehouse
        self._conn.execute(
            "DELETE FROM columns_cache WHERE warehouse = ?", (warehouse_name,)
        )
        self._conn.execute(
            "DELETE FROM tables_cache WHERE warehouse = ?", (warehouse_name,)
        )

        total_schemas = 0
        total_tables = 0
        total_columns = 0
        database_name = None

        # Get database name if available (Snowflake-specific)
        if hasattr(connector, "database") and connector.database:
            database_name = connector.database

        # Index schemas
        try:
            schemas = connector.list_schemas()
        except Exception:
            schemas = []

        for schema_name in schemas:
            # Skip internal schemas
            if schema_name.upper() in ("INFORMATION_SCHEMA",):
                continue

            total_schemas += 1

            # Index tables in this schema
            try:
                tables = connector.list_tables(schema_name)
            except Exception:
                continue

            for table_info in tables:
                tname = table_info["name"]
                ttype = table_info.get("type", "TABLE")
                total_tables += 1

                search_text = _make_search_text(
                    database_name, schema_name, tname, ttype
                )

                self._conn.execute(
                    """INSERT OR REPLACE INTO tables_cache
                       (warehouse, database_name, schema_name, table_name, table_type, search_text)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        warehouse_name,
                        database_name,
                        schema_name,
                        tname,
                        ttype,
                        search_text,
                    ),
                )

                # Index columns
                try:
                    columns = connector.describe_table(schema_name, tname)
                except Exception:
                    continue

                for col in columns:
                    cname = col["name"]
                    ctype = col.get("data_type", "")
                    cnull = 1 if col.get("nullable", True) else 0
                    total_columns += 1

                    col_search = _make_search_text(
                        database_name, schema_name, tname, cname, ctype
                    )

                    self._conn.execute(
                        """INSERT OR REPLACE INTO columns_cache
                           (warehouse, database_name, schema_name, table_name,
                            column_name, data_type, nullable, search_text)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            warehouse_name,
                            database_name,
                            schema_name,
                            tname,
                            cname,
                            ctype,
                            cnull,
                            col_search,
                        ),
                    )

        # Update warehouse summary
        self._conn.execute(
            """INSERT OR REPLACE INTO warehouses
               (name, type, last_indexed, databases_count, schemas_count, tables_count, columns_count)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                warehouse_name,
                warehouse_type,
                now,
                1 if database_name else 0,
                total_schemas,
                total_tables,
                total_columns,
            ),
        )
        self._conn.commit()

        return {
            "warehouse": warehouse_name,
            "type": warehouse_type,
            "schemas_indexed": total_schemas,
            "tables_indexed": total_tables,
            "columns_indexed": total_columns,
            "timestamp": now,
        }

    def search(
        self,
        query: str,
        warehouse: str | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        """Search indexed schema metadata using natural language-style queries.

        Supports:
        - Table name search: "orders", "customer"
        - Column name search: "email", "price"
        - Type-qualified search: "varchar columns", "date fields"
        - Schema-qualified search: "tpch orders"
        - Natural language: "tables with customer info", "columns about price"

        Returns dict with tables and columns results.
        """
        # Tokenize and normalize query
        tokens = self._tokenize_query(query)
        if not tokens:
            return {"tables": [], "columns": [], "query": query, "match_count": 0}

        # Build search conditions
        where_clauses = []
        params: list[Any] = []

        for token in tokens:
            where_clauses.append("search_text LIKE ?")
            params.append(f"%{token}%")

        search_condition = " OR ".join(where_clauses)

        # Warehouse filter
        wh_filter = ""
        wh_params: list[Any] = []
        if warehouse:
            wh_filter = " AND warehouse = ?"
            wh_params = [warehouse]

        # Search tables
        table_sql = f"""
            SELECT warehouse, database_name, schema_name, table_name, table_type, row_count
            FROM tables_cache
            WHERE {search_condition} {wh_filter}
            ORDER BY table_name
            LIMIT ?
        """
        table_rows = self._conn.execute(
            table_sql, params + wh_params + [limit]
        ).fetchall()

        tables = []
        for row in table_rows:
            fqn_parts = [
                p
                for p in [row["database_name"], row["schema_name"], row["table_name"]]
                if p
            ]
            tables.append(
                {
                    "warehouse": row["warehouse"],
                    "database": row["database_name"],
                    "schema": row["schema_name"],
                    "name": row["table_name"],
                    "type": row["table_type"],
                    "row_count": row["row_count"],
                    "fqn": ".".join(fqn_parts),
                }
            )

        # Search columns
        col_sql = f"""
            SELECT warehouse, database_name, schema_name, table_name,
                   column_name, data_type, nullable
            FROM columns_cache
            WHERE {search_condition} {wh_filter}
            ORDER BY column_name
            LIMIT ?
        """
        col_rows = self._conn.execute(col_sql, params + wh_params + [limit]).fetchall()

        columns = []
        for row in col_rows:
            fqn_parts = [
                p
                for p in [
                    row["database_name"],
                    row["schema_name"],
                    row["table_name"],
                    row["column_name"],
                ]
                if p
            ]
            columns.append(
                {
                    "warehouse": row["warehouse"],
                    "database": row["database_name"],
                    "schema": row["schema_name"],
                    "table": row["table_name"],
                    "name": row["column_name"],
                    "data_type": row["data_type"],
                    "nullable": bool(row["nullable"]),
                    "fqn": ".".join(fqn_parts),
                }
            )

        match_count = len(tables) + len(columns)
        return {
            "tables": tables,
            "columns": columns,
            "query": query,
            "match_count": match_count,
        }

    def get_table_detail(
        self,
        warehouse: str,
        schema_name: str,
        table_name: str,
    ) -> dict[str, Any] | None:
        """Get full details for a specific table including all columns."""
        row = self._conn.execute(
            """SELECT * FROM tables_cache
               WHERE warehouse = ? AND schema_name = ? AND table_name = ?""",
            (warehouse, schema_name, table_name),
        ).fetchone()

        if not row:
            return None

        cols = self._conn.execute(
            """SELECT column_name, data_type, nullable, comment
               FROM columns_cache
               WHERE warehouse = ? AND schema_name = ? AND table_name = ?
               ORDER BY id""",
            (warehouse, schema_name, table_name),
        ).fetchall()

        return {
            "warehouse": row["warehouse"],
            "database": row["database_name"],
            "schema": row["schema_name"],
            "name": row["table_name"],
            "type": row["table_type"],
            "row_count": row["row_count"],
            "columns": [
                {
                    "name": c["column_name"],
                    "data_type": c["data_type"],
                    "nullable": bool(c["nullable"]),
                    "comment": c["comment"],
                }
                for c in cols
            ],
        }

    def cache_status(self) -> dict[str, Any]:
        """Return status of all indexed warehouses."""
        rows = self._conn.execute("SELECT * FROM warehouses ORDER BY name").fetchall()
        warehouses = []
        for row in rows:
            warehouses.append(
                {
                    "name": row["name"],
                    "type": row["type"],
                    "last_indexed": row["last_indexed"],
                    "databases_count": row["databases_count"],
                    "schemas_count": row["schemas_count"],
                    "tables_count": row["tables_count"],
                    "columns_count": row["columns_count"],
                }
            )

        total_tables = self._conn.execute(
            "SELECT COUNT(*) as cnt FROM tables_cache"
        ).fetchone()["cnt"]
        total_columns = self._conn.execute(
            "SELECT COUNT(*) as cnt FROM columns_cache"
        ).fetchone()["cnt"]

        return {
            "warehouses": warehouses,
            "total_tables": total_tables,
            "total_columns": total_columns,
            "cache_path": self._db_path,
        }

    def _tokenize_query(self, query: str) -> list[str]:
        """Tokenize a search query into individual search terms."""
        # Remove common filler words
        stop_words = {
            "the",
            "a",
            "an",
            "in",
            "on",
            "at",
            "to",
            "for",
            "of",
            "with",
            "about",
            "from",
            "that",
            "which",
            "where",
            "what",
            "how",
            "find",
            "show",
            "get",
            "list",
            "all",
            "any",
        }
        # Tokenize
        raw_tokens = re.findall(r"[a-zA-Z0-9_]+", query.lower())
        # Filter stop words but keep at least one token
        filtered = [t for t in raw_tokens if t not in stop_words]
        return filtered if filtered else raw_tokens[:1]

    def close(self) -> None:
        self._conn.close()

    def __del__(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass
