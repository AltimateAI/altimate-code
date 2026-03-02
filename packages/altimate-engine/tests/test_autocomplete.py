"""Tests for sql.autocomplete — schema-aware auto-complete suggestions."""

import tempfile
import os

from altimate_engine.sql.autocomplete import autocomplete_sql
from altimate_engine.schema.cache import SchemaCache


def _make_cache_with_data() -> SchemaCache:
    """Create a SchemaCache with pre-populated test data."""
    tmp = tempfile.mkdtemp()
    db_path = os.path.join(tmp, "test_autocomplete.db")
    cache = SchemaCache(db_path=db_path)
    conn = cache._conn

    # Insert test tables (using actual schema: table_name, table_type)
    conn.execute(
        "INSERT INTO tables_cache (warehouse, database_name, schema_name, table_name, table_type, search_text) VALUES (?, ?, ?, ?, ?, ?)",
        ("wh1", "db1", "public", "customers", "TABLE", "customers public db1"),
    )
    conn.execute(
        "INSERT INTO tables_cache (warehouse, database_name, schema_name, table_name, table_type, search_text) VALUES (?, ?, ?, ?, ?, ?)",
        ("wh1", "db1", "public", "customer_orders", "TABLE", "customer orders public db1"),
    )
    conn.execute(
        "INSERT INTO tables_cache (warehouse, database_name, schema_name, table_name, table_type, search_text) VALUES (?, ?, ?, ?, ?, ?)",
        ("wh1", "db1", "analytics", "revenue_daily", "VIEW", "revenue daily analytics db1"),
    )
    conn.execute(
        "INSERT INTO tables_cache (warehouse, database_name, schema_name, table_name, table_type, search_text) VALUES (?, ?, ?, ?, ?, ?)",
        ("wh2", "db2", "raw", "events", "TABLE", "events raw db2"),
    )

    # Insert test columns (using actual schema: column_name)
    conn.execute(
        "INSERT INTO columns_cache (warehouse, database_name, schema_name, table_name, column_name, data_type, nullable, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("wh1", "db1", "public", "customers", "customer_id", "INTEGER", 1, "customer id public customers"),
    )
    conn.execute(
        "INSERT INTO columns_cache (warehouse, database_name, schema_name, table_name, column_name, data_type, nullable, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("wh1", "db1", "public", "customers", "customer_name", "VARCHAR", 1, "customer name public customers"),
    )
    conn.execute(
        "INSERT INTO columns_cache (warehouse, database_name, schema_name, table_name, column_name, data_type, nullable, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("wh1", "db1", "public", "customer_orders", "order_id", "INTEGER", 0, "order id public customer orders"),
    )
    conn.execute(
        "INSERT INTO columns_cache (warehouse, database_name, schema_name, table_name, column_name, data_type, nullable, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("wh1", "db1", "analytics", "revenue_daily", "revenue", "DECIMAL", 1, "revenue analytics revenue daily"),
    )
    conn.commit()

    return cache


class TestAutocompleteEmpty:
    def test_empty_prefix(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("", cache=cache)
        assert result["suggestion_count"] == 0
        assert result["suggestions"] == []

    def test_whitespace_prefix(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("   ", cache=cache)
        assert result["suggestion_count"] == 0


class TestAutocompleteTables:
    def test_table_suggestions_by_prefix(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("cust", position="table", cache=cache)
        assert result["suggestion_count"] >= 1
        names = [s["name"] for s in result["suggestions"]]
        assert "customers" in names

    def test_table_suggestions_multiple_matches(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("customer", position="table", cache=cache)
        names = [s["name"] for s in result["suggestions"]]
        assert "customers" in names
        assert "customer_orders" in names

    def test_table_type_field(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("cust", position="table", cache=cache)
        for s in result["suggestions"]:
            assert s["type"] == "table"


class TestAutocompleteColumns:
    def test_column_suggestions_by_prefix(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("customer", position="column", cache=cache)
        assert result["suggestion_count"] >= 1
        names = [s["name"] for s in result["suggestions"]]
        assert "customer_id" in names or "customer_name" in names

    def test_column_context_boosting(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql(
            "customer",
            position="column",
            table_context=["customers"],
            cache=cache,
        )
        # Columns from context table should be marked
        context_cols = [s for s in result["suggestions"] if s.get("in_context")]
        assert len(context_cols) >= 1

    def test_column_type_field(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("order", position="column", cache=cache)
        for s in result["suggestions"]:
            assert s["type"] == "column"


class TestAutocompleteSchemas:
    def test_schema_suggestions(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("pub", position="schema", cache=cache)
        names = [s["name"] for s in result["suggestions"]]
        assert "public" in names

    def test_schema_type_field(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("pub", position="schema", cache=cache)
        for s in result["suggestions"]:
            assert s["type"] == "schema"


class TestAutocompleteAny:
    def test_any_returns_mixed_types(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("customer", position="any", cache=cache)
        types = set(s["type"] for s in result["suggestions"])
        # Should have at least tables and columns
        assert "table" in types
        assert "column" in types

    def test_warehouse_filter(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("e", position="table", warehouse="wh2", cache=cache)
        for s in result["suggestions"]:
            assert s["warehouse"] == "wh2"

    def test_limit_respected(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("c", position="any", limit=2, cache=cache)
        assert result["suggestion_count"] <= 2

    def test_prefix_match_sorted_first(self):
        cache = _make_cache_with_data()
        result = autocomplete_sql("customer", position="table", cache=cache)
        if result["suggestion_count"] >= 2:
            # Items starting with "customer" should come before others
            first_name = result["suggestions"][0]["name"].lower()
            assert first_name.startswith("customer")
