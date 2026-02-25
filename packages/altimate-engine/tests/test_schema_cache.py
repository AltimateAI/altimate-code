"""Tests for SchemaCache — SQLite-backed warehouse metadata indexing and search."""

import os
import tempfile

import pytest

from altimate_engine.schema.cache import SchemaCache, _make_search_text


class FakeConnector:
    """Minimal connector stub for testing SchemaCache.index_warehouse()."""

    def __init__(self, schemas=None):
        self._schemas = schemas or {
            "public": [
                {
                    "name": "orders",
                    "type": "TABLE",
                    "columns": [
                        {"name": "id", "data_type": "INTEGER", "nullable": False},
                        {"name": "customer_id", "data_type": "INTEGER", "nullable": False},
                        {"name": "order_date", "data_type": "DATE", "nullable": True},
                        {"name": "total_amount", "data_type": "DECIMAL(10,2)", "nullable": True},
                    ],
                },
                {
                    "name": "customers",
                    "type": "TABLE",
                    "columns": [
                        {"name": "id", "data_type": "INTEGER", "nullable": False},
                        {"name": "email", "data_type": "VARCHAR(255)", "nullable": False},
                        {"name": "name", "data_type": "VARCHAR(100)", "nullable": True},
                    ],
                },
            ],
            "analytics": [
                {
                    "name": "daily_revenue",
                    "type": "VIEW",
                    "columns": [
                        {"name": "day", "data_type": "DATE", "nullable": False},
                        {"name": "revenue", "data_type": "DECIMAL(12,2)", "nullable": True},
                    ],
                },
            ],
        }

    def list_schemas(self):
        return list(self._schemas.keys())

    def list_tables(self, schema_name):
        tables = self._schemas.get(schema_name, [])
        return [{"name": t["name"], "type": t.get("type", "TABLE")} for t in tables]

    def describe_table(self, schema_name, table_name):
        tables = self._schemas.get(schema_name, [])
        for t in tables:
            if t["name"] == table_name:
                return t["columns"]
        return []


@pytest.fixture
def cache():
    """Create a temporary SchemaCache backed by a temp file."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    c = SchemaCache(db_path=path)
    yield c
    c.close()
    os.unlink(path)


@pytest.fixture
def indexed_cache(cache):
    """Cache with a pre-indexed warehouse."""
    connector = FakeConnector()
    cache.index_warehouse("test-wh", "duckdb", connector)
    return cache


class TestMakeSearchText:
    def test_basic(self):
        result = _make_search_text("ORDERS", "public")
        assert "orders" in result
        assert "public" in result

    def test_underscore_split(self):
        result = _make_search_text("customer_orders")
        assert "customer_orders" in result
        assert "customer" in result
        assert "orders" in result

    def test_none_skipped(self):
        result = _make_search_text(None, "orders", None)
        assert "orders" in result
        assert "none" not in result.lower()


class TestIndexWarehouse:
    def test_indexes_all_schemas(self, cache):
        connector = FakeConnector()
        result = cache.index_warehouse("test-wh", "duckdb", connector)
        assert result["warehouse"] == "test-wh"
        assert result["type"] == "duckdb"
        assert result["schemas_indexed"] == 2
        assert result["tables_indexed"] == 3
        assert result["columns_indexed"] == 9
        assert "timestamp" in result

    def test_skips_information_schema(self, cache):
        connector = FakeConnector(schemas={
            "INFORMATION_SCHEMA": [{"name": "tables", "type": "TABLE", "columns": []}],
            "public": [{"name": "orders", "type": "TABLE", "columns": []}],
        })
        result = cache.index_warehouse("test-wh", "postgres", connector)
        assert result["schemas_indexed"] == 1

    def test_reindex_replaces_data(self, cache):
        connector = FakeConnector()
        cache.index_warehouse("test-wh", "duckdb", connector)

        # Re-index with fewer tables
        small_connector = FakeConnector(schemas={
            "public": [{"name": "only_table", "type": "TABLE", "columns": []}],
        })
        result = cache.index_warehouse("test-wh", "duckdb", small_connector)
        assert result["tables_indexed"] == 1

        # Search should only find the new table
        search = cache.search("orders")
        assert search["match_count"] == 0

    def test_handles_connector_errors(self, cache):
        class BrokenConnector:
            def list_schemas(self):
                raise RuntimeError("connection lost")

        result = cache.index_warehouse("broken", "postgres", BrokenConnector())
        assert result["schemas_indexed"] == 0
        assert result["tables_indexed"] == 0


class TestSearch:
    def test_find_table_by_name(self, indexed_cache):
        result = indexed_cache.search("orders")
        assert result["match_count"] > 0
        table_names = [t["name"] for t in result["tables"]]
        assert "orders" in table_names

    def test_find_column_by_name(self, indexed_cache):
        result = indexed_cache.search("email")
        assert len(result["columns"]) > 0
        col_names = [c["name"] for c in result["columns"]]
        assert "email" in col_names

    def test_find_by_partial_compound_name(self, indexed_cache):
        result = indexed_cache.search("customer")
        assert result["match_count"] > 0
        # Should find customers table AND customer_id column
        all_names = (
            [t["name"] for t in result["tables"]]
            + [c["name"] for c in result["columns"]]
        )
        assert any("customer" in n for n in all_names)

    def test_warehouse_filter(self, indexed_cache):
        result = indexed_cache.search("orders", warehouse="nonexistent")
        assert result["match_count"] == 0

        result = indexed_cache.search("orders", warehouse="test-wh")
        assert result["match_count"] > 0

    def test_limit(self, indexed_cache):
        result = indexed_cache.search("a", limit=1)
        assert len(result["tables"]) <= 1
        assert len(result["columns"]) <= 1

    def test_empty_query_returns_empty(self, indexed_cache):
        result = indexed_cache.search("")
        assert result["match_count"] == 0

    def test_stop_words_filtered(self, indexed_cache):
        # "find tables with" are all stop words, "revenue" is the real term
        result = indexed_cache.search("find tables with revenue")
        assert result["match_count"] > 0
        table_names = [t["name"] for t in result["tables"]]
        assert "daily_revenue" in table_names

    def test_fqn_format(self, indexed_cache):
        result = indexed_cache.search("orders")
        for t in result["tables"]:
            assert "." in t["fqn"]  # schema.table at minimum

    def test_column_metadata(self, indexed_cache):
        result = indexed_cache.search("email")
        for c in result["columns"]:
            assert "data_type" in c
            assert "nullable" in c
            assert isinstance(c["nullable"], bool)


class TestGetTableDetail:
    def test_returns_table_with_columns(self, indexed_cache):
        detail = indexed_cache.get_table_detail("test-wh", "public", "orders")
        assert detail is not None
        assert detail["name"] == "orders"
        assert len(detail["columns"]) == 4
        col_names = [c["name"] for c in detail["columns"]]
        assert "id" in col_names
        assert "order_date" in col_names

    def test_returns_none_for_missing(self, indexed_cache):
        detail = indexed_cache.get_table_detail("test-wh", "public", "nonexistent")
        assert detail is None


class TestCacheStatus:
    def test_empty_cache(self, cache):
        status = cache.cache_status()
        assert status["total_tables"] == 0
        assert status["total_columns"] == 0
        assert len(status["warehouses"]) == 0
        assert "cache_path" in status

    def test_after_indexing(self, indexed_cache):
        status = indexed_cache.cache_status()
        assert status["total_tables"] == 3
        assert status["total_columns"] == 9
        assert len(status["warehouses"]) == 1

        wh = status["warehouses"][0]
        assert wh["name"] == "test-wh"
        assert wh["type"] == "duckdb"
        assert wh["schemas_count"] == 2
        assert wh["tables_count"] == 3
        assert wh["columns_count"] == 9
        assert wh["last_indexed"] is not None
