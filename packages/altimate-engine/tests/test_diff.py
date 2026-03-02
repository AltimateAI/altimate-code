"""Tests for SQL diff — compare two SQL queries and show differences."""

import pytest
from altimate_engine.sql.diff import diff_sql


class TestNoDifferences:
    def test_identical_sql(self):
        sql = "SELECT id, name FROM users WHERE active = true"
        result = diff_sql(sql, sql)
        assert result["has_changes"] is False
        assert result["additions"] == 0
        assert result["deletions"] == 0
        assert result["change_count"] == 0
        assert result["similarity"] == 1.0
        assert result["unified_diff"] == ""
        assert result["changes"] == []

    def test_identical_multiline(self):
        sql = "SELECT\n  id,\n  name\nFROM users\nWHERE active = true"
        result = diff_sql(sql, sql)
        assert result["has_changes"] is False
        assert result["similarity"] == 1.0


class TestSimpleChanges:
    def test_single_word_change(self):
        original = "SELECT id FROM users"
        modified = "SELECT id FROM customers"
        result = diff_sql(original, modified)
        assert result["has_changes"] is True
        assert result["change_count"] >= 1
        assert result["similarity"] < 1.0
        assert result["similarity"] > 0.0

    def test_added_column(self):
        original = "SELECT id FROM users"
        modified = "SELECT id, name FROM users"
        result = diff_sql(original, modified)
        assert result["has_changes"] is True
        assert result["change_count"] >= 1

    def test_removed_clause(self):
        original = "SELECT id FROM users WHERE active = true"
        modified = "SELECT id FROM users"
        result = diff_sql(original, modified)
        assert result["has_changes"] is True
        assert result["change_count"] >= 1


class TestMultilineChanges:
    def test_added_line(self):
        original = "SELECT id\nFROM users"
        modified = "SELECT id\nFROM users\nWHERE active = true"
        result = diff_sql(original, modified)
        assert result["has_changes"] is True
        assert result["additions"] >= 1

    def test_removed_line(self):
        original = "SELECT id\nFROM users\nWHERE active = true"
        modified = "SELECT id\nFROM users"
        result = diff_sql(original, modified)
        assert result["has_changes"] is True
        assert result["deletions"] >= 1

    def test_replaced_line(self):
        original = "SELECT id\nFROM users\nWHERE active = true"
        modified = "SELECT id\nFROM users\nWHERE status = 'active'"
        result = diff_sql(original, modified)
        assert result["has_changes"] is True
        assert result["unified_diff"] != ""


class TestUnifiedDiff:
    def test_unified_diff_contains_markers(self):
        original = "SELECT id\nFROM users"
        modified = "SELECT id\nFROM customers"
        result = diff_sql(original, modified)
        assert "---" in result["unified_diff"]
        assert "+++" in result["unified_diff"]

    def test_unified_diff_file_names(self):
        original = "SELECT 1"
        modified = "SELECT 2"
        result = diff_sql(original, modified)
        assert "original.sql" in result["unified_diff"]
        assert "modified.sql" in result["unified_diff"]


class TestContextLines:
    def test_custom_context_lines(self):
        original = "SELECT\n  id,\n  name,\n  email,\n  phone\nFROM users\nWHERE active = true"
        modified = "SELECT\n  id,\n  name,\n  email,\n  phone\nFROM customers\nWHERE active = true"
        result_default = diff_sql(original, modified, context_lines=3)
        result_zero = diff_sql(original, modified, context_lines=0)
        # Zero context should produce a shorter diff
        assert len(result_zero["unified_diff"]) <= len(result_default["unified_diff"])


class TestSimilarity:
    def test_completely_different(self):
        original = "SELECT id FROM users"
        modified = "INSERT INTO orders VALUES (1, 'test')"
        result = diff_sql(original, modified)
        assert result["similarity"] < 0.5

    def test_very_similar(self):
        original = "SELECT id, name, email FROM users WHERE active = true ORDER BY name LIMIT 100"
        modified = "SELECT id, name, email FROM users WHERE active = false ORDER BY name LIMIT 100"
        result = diff_sql(original, modified)
        assert result["similarity"] > 0.9

    def test_similarity_is_rounded(self):
        original = "SELECT 1"
        modified = "SELECT 2"
        result = diff_sql(original, modified)
        # similarity should be a float rounded to 4 decimal places
        assert isinstance(result["similarity"], float)
        s_str = str(result["similarity"])
        if "." in s_str:
            decimal_places = len(s_str.split(".")[1])
            assert decimal_places <= 4


class TestChangeStructure:
    def test_change_has_required_fields(self):
        original = "SELECT id FROM users"
        modified = "SELECT id FROM customers"
        result = diff_sql(original, modified)
        for change in result["changes"]:
            assert "type" in change
            assert change["type"] in ("replace", "insert", "delete")
            assert "original_start" in change
            assert "original_end" in change
            assert "modified_start" in change
            assert "modified_end" in change
            assert "original_text" in change
            assert "modified_text" in change

    def test_insert_change(self):
        original = "SELECT id FROM users"
        modified = "SELECT id FROM users WHERE active = true"
        result = diff_sql(original, modified)
        insert_changes = [c for c in result["changes"] if c["type"] == "insert"]
        # The diff should detect an insertion
        assert any(c["modified_text"] != "" for c in result["changes"])

    def test_delete_change(self):
        original = "SELECT id FROM users WHERE active = true"
        modified = "SELECT id FROM users"
        result = diff_sql(original, modified)
        assert any(c["original_text"] != "" for c in result["changes"])

    def test_changes_limited_to_50(self):
        # Create SQL with many small differences
        original_lines = [f"SELECT col_{i}" for i in range(100)]
        modified_lines = [f"SELECT col_{i}_modified" for i in range(100)]
        original = "\n".join(original_lines)
        modified = "\n".join(modified_lines)
        result = diff_sql(original, modified)
        assert len(result["changes"]) <= 50


class TestEdgeCases:
    def test_empty_original(self):
        result = diff_sql("", "SELECT 1")
        assert result["has_changes"] is True
        assert result["additions"] >= 1

    def test_empty_modified(self):
        result = diff_sql("SELECT 1", "")
        assert result["has_changes"] is True
        assert result["deletions"] >= 1

    def test_both_empty(self):
        result = diff_sql("", "")
        assert result["has_changes"] is False
        assert result["similarity"] == 1.0

    def test_whitespace_only_change(self):
        original = "SELECT id FROM users"
        modified = "SELECT  id  FROM  users"
        result = diff_sql(original, modified)
        assert result["has_changes"] is True

    def test_newline_differences(self):
        original = "SELECT id FROM users"
        modified = "SELECT id\nFROM users"
        result = diff_sql(original, modified)
        assert result["has_changes"] is True

    def test_large_sql(self):
        original = "SELECT " + ", ".join(f"col_{i}" for i in range(200)) + " FROM big_table"
        modified = "SELECT " + ", ".join(f"col_{i}" for i in range(200)) + " FROM bigger_table"
        result = diff_sql(original, modified)
        assert result["has_changes"] is True
        assert result["similarity"] > 0.9
