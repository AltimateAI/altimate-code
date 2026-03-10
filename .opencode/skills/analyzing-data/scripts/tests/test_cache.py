"""Tests for cache.py - concept, pattern, and table caching."""

from pathlib import Path
from unittest import mock

import pytest


# Mock CACHE_DIR before importing cache module
@pytest.fixture(autouse=True)
def mock_cache_dir(tmp_path):
    """Use a temporary directory for all cache tests."""
    with mock.patch("cache.CACHE_DIR", tmp_path):
        yield tmp_path


class TestConceptCache:
    """Tests for concept caching functions."""

    def test_lookup_concept_not_found(self, mock_cache_dir):
        import cache

        result = cache.lookup_concept("nonexistent")
        assert result is None

    def test_learn_and_lookup_concept(self, mock_cache_dir):
        import cache

        # Learn a concept
        result = cache.learn_concept(
            concept="customers",
            table="HQ.MART.CUSTOMERS",
            key_column="CUST_ID",
            date_column="CREATED_AT",
        )

        assert result["table"] == "HQ.MART.CUSTOMERS"
        assert result["key_column"] == "CUST_ID"
        assert result["date_column"] == "CREATED_AT"
        assert "learned_at" in result

        # Look it up
        found = cache.lookup_concept("customers")
        assert found is not None
        assert found["table"] == "HQ.MART.CUSTOMERS"

    def test_concept_case_insensitive(self, mock_cache_dir):
        import cache

        cache.learn_concept("Customers", "HQ.MART.CUSTOMERS")
        assert cache.lookup_concept("customers") is not None
        assert cache.lookup_concept("CUSTOMERS") is not None

    def test_list_concepts(self, mock_cache_dir):
        import cache

        cache.learn_concept("customers", "TABLE1")
        cache.learn_concept("orders", "TABLE2")

        concepts = cache.list_concepts()
        assert len(concepts) == 2
        assert "customers" in concepts
        assert "orders" in concepts


class TestPatternCache:
    """Tests for pattern caching functions."""

    def test_lookup_pattern_no_match(self, mock_cache_dir):
        import cache

        result = cache.lookup_pattern("some random question")
        assert result == []

    def test_learn_and_lookup_pattern(self, mock_cache_dir):
        import cache

        cache.learn_pattern(
            name="customer_count",
            question_types=["how many customers", "count customers"],
            strategy=["Query CUSTOMERS table", "Use COUNT(*)"],
            tables_used=["HQ.MART.CUSTOMERS"],
            gotchas=["Filter by active status"],
        )

        # Should match
        matches = cache.lookup_pattern("how many customers do we have")
        assert len(matches) == 1
        assert matches[0]["name"] == "customer_count"

        # Should also match variant
        matches = cache.lookup_pattern("count customers please")
        assert len(matches) == 1

    def test_record_pattern_outcome(self, mock_cache_dir):
        import cache

        cache.learn_pattern(
            name="test_pattern",
            question_types=["test"],
            strategy=["step1"],
            tables_used=["TABLE"],
            gotchas=[],
        )

        # Initial counts
        patterns = cache.list_patterns()
        assert patterns["test_pattern"]["success_count"] == 1
        assert patterns["test_pattern"]["failure_count"] == 0

        # Record success
        cache.record_pattern_outcome("test_pattern", success=True)
        patterns = cache.list_patterns()
        assert patterns["test_pattern"]["success_count"] == 2

        # Record failure
        cache.record_pattern_outcome("test_pattern", success=False)
        patterns = cache.list_patterns()
        assert patterns["test_pattern"]["failure_count"] == 1

    def test_delete_pattern(self, mock_cache_dir):
        import cache

        cache.learn_pattern(
            name="to_delete",
            question_types=["test"],
            strategy=["step1"],
            tables_used=["TABLE"],
            gotchas=[],
        )

        assert cache.delete_pattern("to_delete") is True
        assert cache.delete_pattern("to_delete") is False  # Already deleted
        assert "to_delete" not in cache.list_patterns()


class TestTableCache:
    """Tests for table schema caching."""

    def test_get_table_not_found(self, mock_cache_dir):
        import cache

        result = cache.get_table("NONEXISTENT.TABLE")
        assert result is None

    def test_set_and_get_table(self, mock_cache_dir):
        import cache

        columns = [
            {"name": "ID", "type": "INT"},
            {"name": "NAME", "type": "VARCHAR"},
        ]

        result = cache.set_table(
            full_name="DB.SCHEMA.TABLE",
            columns=columns,
            row_count=1000,
            comment="Test table",
        )

        assert result["full_name"] == "DB.SCHEMA.TABLE"
        assert result["columns"] == columns
        assert result["row_count"] == 1000

        # Retrieve it
        found = cache.get_table("DB.SCHEMA.TABLE")
        assert found is not None
        assert found["row_count"] == 1000

    def test_table_name_case_insensitive(self, mock_cache_dir):
        import cache

        cache.set_table("db.schema.table", [])
        assert cache.get_table("DB.SCHEMA.TABLE") is not None

    def test_delete_table(self, mock_cache_dir):
        import cache

        cache.set_table("DB.SCHEMA.TABLE", [])
        assert cache.delete_table("DB.SCHEMA.TABLE") is True
        assert cache.delete_table("DB.SCHEMA.TABLE") is False
        assert cache.get_table("DB.SCHEMA.TABLE") is None


class TestCacheManagement:
    """Tests for cache statistics and clearing."""

    def test_cache_stats(self, mock_cache_dir):
        import cache

        cache.learn_concept("c1", "T1")
        cache.learn_concept("c2", "T2")
        cache.learn_pattern("p1", ["q"], ["s"], ["t"], [])

        stats = cache.cache_stats()
        assert stats["concepts_count"] == 2
        assert stats["patterns_count"] == 1
        assert stats["cache_dir"] == str(mock_cache_dir)

    def test_clear_cache_all(self, mock_cache_dir):
        import cache

        cache.learn_concept("c1", "T1")
        cache.learn_pattern("p1", ["q"], ["s"], ["t"], [])

        result = cache.clear_cache("all")
        assert result["concepts_cleared"] == 1
        assert result["patterns_cleared"] == 1
        assert cache.list_concepts() == {}
        assert cache.list_patterns() == {}

    def test_clear_cache_concepts_only(self, mock_cache_dir):
        import cache

        cache.learn_concept("c1", "T1")
        cache.learn_pattern("p1", ["q"], ["s"], ["t"], [])

        result = cache.clear_cache("concepts")
        assert result["concepts_cleared"] == 1
        assert result["patterns_cleared"] == 0
        assert cache.list_concepts() == {}
        assert len(cache.list_patterns()) == 1


class TestBulkImport:
    """Tests for loading concepts from warehouse.md."""

    def test_load_concepts_from_warehouse_md(self, mock_cache_dir, tmp_path):
        import cache

        # Create a test warehouse.md
        warehouse_md = tmp_path / "warehouse.md"
        warehouse_md.write_text("""
# Warehouse Reference

| Concept | Table | Key Column | Date Column |
|---------|-------|------------|-------------|
| customers | HQ.MART.CUSTOMERS | CUST_ID | CREATED_AT |
| orders | HQ.MART.ORDERS | ORDER_ID | ORDER_DATE |
| invalid | no_dots | - | - |
""")

        count = cache.load_concepts_from_warehouse_md(warehouse_md)
        assert count == 2  # 'invalid' should be skipped (no dots)

        concepts = cache.list_concepts()
        assert "customers" in concepts
        assert concepts["customers"]["table"] == "HQ.MART.CUSTOMERS"
        assert "orders" in concepts

    def test_load_concepts_file_not_found(self, mock_cache_dir):
        import cache

        count = cache.load_concepts_from_warehouse_md(Path("/nonexistent/file.md"))
        assert count == 0
