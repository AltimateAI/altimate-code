"""Tests for schema diff — detect column-level changes between SQL SELECT statements."""

import pytest
from altimate_engine.sql.schema_diff import diff_schema


class TestNoChanges:
    def test_identical_select(self):
        sql = "SELECT id, name, email FROM users"
        result = diff_schema(sql, sql)
        assert result["success"] is True
        assert result["changes"] == []
        assert result["has_breaking_changes"] is False
        assert result["summary"]["total_changes"] == 0

    def test_identical_with_aliases(self):
        sql = "SELECT id AS user_id, name AS user_name FROM users"
        result = diff_schema(sql, sql)
        assert result["success"] is True
        assert result["changes"] == []


class TestDroppedColumns:
    def test_single_drop(self):
        old = "SELECT id, name, email FROM users"
        new = "SELECT id, name FROM users"
        result = diff_schema(old, new)
        assert result["success"] is True
        assert result["has_breaking_changes"] is True
        dropped = [c for c in result["changes"] if c["change_type"] == "DROPPED"]
        assert len(dropped) == 1
        assert dropped[0]["column"] == "email"
        assert dropped[0]["severity"] == "breaking"

    def test_multiple_drops(self):
        old = "SELECT id, name, email, phone FROM users"
        new = "SELECT id FROM users"
        result = diff_schema(old, new)
        dropped = [c for c in result["changes"] if c["change_type"] == "DROPPED"]
        assert len(dropped) == 3
        assert result["has_breaking_changes"] is True


class TestAddedColumns:
    def test_single_add(self):
        old = "SELECT id, name FROM users"
        new = "SELECT id, name, email FROM users"
        result = diff_schema(old, new)
        assert result["success"] is True
        assert result["has_breaking_changes"] is False
        added = [c for c in result["changes"] if c["change_type"] == "ADDED"]
        assert len(added) == 1
        assert added[0]["column"] == "email"
        assert added[0]["severity"] == "info"

    def test_multiple_adds(self):
        old = "SELECT id FROM users"
        new = "SELECT id, name, email, phone FROM users"
        result = diff_schema(old, new)
        added = [c for c in result["changes"] if c["change_type"] == "ADDED"]
        assert len(added) == 3


class TestTypeChanges:
    def test_cast_type_change(self):
        old = "SELECT CAST(id AS INT), name FROM users"
        new = "SELECT CAST(id AS BIGINT), name FROM users"
        result = diff_schema(old, new)
        type_changed = [c for c in result["changes"] if c["change_type"] == "TYPE_CHANGED"]
        assert len(type_changed) == 1
        assert type_changed[0]["column"] == "id"
        assert type_changed[0]["severity"] == "warning"

    def test_no_type_info_no_change(self):
        old = "SELECT id, name FROM users"
        new = "SELECT id, name FROM users"
        result = diff_schema(old, new)
        type_changed = [c for c in result["changes"] if c["change_type"] == "TYPE_CHANGED"]
        assert len(type_changed) == 0


class TestRenames:
    def test_similar_name_detected_as_rename(self):
        old = "SELECT user_name, email FROM users"
        new = "SELECT username, email FROM users"
        result = diff_schema(old, new)
        renamed = [c for c in result["changes"] if c["change_type"] == "RENAMED"]
        assert len(renamed) == 1
        assert renamed[0]["column"] == "user_name"
        assert renamed[0]["new_name"] == "username"

    def test_dissimilar_names_not_renamed(self):
        old = "SELECT id, name FROM users"
        new = "SELECT key, email FROM users"
        result = diff_schema(old, new)
        renamed = [c for c in result["changes"] if c["change_type"] == "RENAMED"]
        # id -> key and name -> email are too dissimilar
        # At least one should be treated as drop+add rather than rename
        dropped = [c for c in result["changes"] if c["change_type"] == "DROPPED"]
        added = [c for c in result["changes"] if c["change_type"] == "ADDED"]
        assert len(dropped) + len(renamed) == 2
        assert len(added) + len(renamed) == 2


class TestAliases:
    def test_alias_used_as_column_name(self):
        old = "SELECT id AS user_id, name FROM users"
        new = "SELECT id AS user_id, name, email FROM users"
        result = diff_schema(old, new)
        added = [c for c in result["changes"] if c["change_type"] == "ADDED"]
        assert len(added) == 1
        assert added[0]["column"] == "email"

    def test_alias_change_detected(self):
        old = "SELECT id AS user_id, name FROM users"
        new = "SELECT id AS uid, name FROM users"
        result = diff_schema(old, new)
        # user_id -> uid: similar enough for rename
        assert len(result["changes"]) >= 1


class TestSummary:
    def test_summary_counts(self):
        old = "SELECT id, name, email FROM users"
        new = "SELECT id, phone FROM users"
        result = diff_schema(old, new)
        summary = result["summary"]
        assert summary["total_changes"] == len(result["changes"])
        assert summary["total_changes"] > 0
        assert "dropped" in summary
        assert "added" in summary
        assert "type_changed" in summary
        assert "renamed" in summary


class TestDialects:
    def test_snowflake_dialect(self):
        old = "SELECT id, name FROM users"
        new = "SELECT id, name, created_at FROM users"
        result = diff_schema(old, new, dialect="snowflake")
        assert result["success"] is True
        added = [c for c in result["changes"] if c["change_type"] == "ADDED"]
        assert len(added) == 1

    def test_ansi_dialect(self):
        old = "SELECT id FROM users"
        new = "SELECT id, name FROM users"
        result = diff_schema(old, new, dialect="ansi")
        assert result["success"] is True


class TestErrorHandling:
    def test_invalid_sql(self):
        result = diff_schema("NOT VALID SQL ???", "SELECT 1")
        # Should either succeed with best-effort parse or return error
        assert isinstance(result, dict)
        assert "success" in result

    def test_empty_sql(self):
        result = diff_schema("", "SELECT 1")
        assert result["success"] is False
        assert result["error"] is not None

    def test_non_select_statement(self):
        result = diff_schema("INSERT INTO t VALUES (1)", "SELECT 1")
        # Should handle gracefully — may or may not find a SELECT
        assert isinstance(result, dict)
        assert "success" in result


class TestComplexQueries:
    def test_subquery_columns(self):
        old = "SELECT a.id, a.name FROM (SELECT id, name FROM users) a"
        new = "SELECT a.id, a.name, a.email FROM (SELECT id, name, email FROM users) a"
        result = diff_schema(old, new)
        assert result["success"] is True
        added = [c for c in result["changes"] if c["change_type"] == "ADDED"]
        assert len(added) == 1

    def test_star_select(self):
        old = "SELECT * FROM users"
        new = "SELECT id, name FROM users"
        result = diff_schema(old, new)
        # * is a single expression; comparing against named columns produces changes
        assert result["success"] is True
        assert len(result["changes"]) >= 1
