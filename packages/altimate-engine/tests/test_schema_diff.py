"""Tests for sql/schema_diff.py — schema change detection."""

import pytest

from altimate_engine.sql.schema_diff import diff_schema


class TestDroppedColumns:
    """Dropped columns → BREAKING severity."""

    def test_single_dropped_column(self):
        old = "SELECT id, name, email FROM users"
        new = "SELECT id, name FROM users"
        result = diff_schema(old, new)
        assert result["success"]
        assert result["has_breaking_changes"]
        dropped = [c for c in result["changes"] if c["change_type"] == "DROPPED"]
        assert len(dropped) == 1
        assert dropped[0]["column"].lower() == "email"
        assert dropped[0]["severity"] == "breaking"

    def test_multiple_dropped_columns(self):
        old = "SELECT id, name, email, phone FROM users"
        new = "SELECT id FROM users"
        result = diff_schema(old, new)
        assert result["success"]
        assert result["has_breaking_changes"]
        dropped = [c for c in result["changes"] if c["change_type"] == "DROPPED"]
        assert len(dropped) == 3

    def test_no_dropped_columns(self):
        old = "SELECT id, name FROM users"
        new = "SELECT id, name FROM users"
        result = diff_schema(old, new)
        assert result["success"]
        assert not result["has_breaking_changes"]
        assert len(result["changes"]) == 0


class TestAddedColumns:
    """Added columns → INFO severity."""

    def test_single_added_column(self):
        old = "SELECT id, name FROM users"
        new = "SELECT id, name, email FROM users"
        result = diff_schema(old, new)
        assert result["success"]
        assert not result["has_breaking_changes"]
        added = [c for c in result["changes"] if c["change_type"] == "ADDED"]
        assert len(added) == 1
        assert added[0]["column"].lower() == "email"
        assert added[0]["severity"] == "info"

    def test_multiple_added_columns(self):
        old = "SELECT id FROM users"
        new = "SELECT id, name, email, phone FROM users"
        result = diff_schema(old, new)
        assert result["success"]
        added = [c for c in result["changes"] if c["change_type"] == "ADDED"]
        assert len(added) == 3


class TestTypeChanges:
    """Type changes → WARNING severity."""

    def test_type_change_via_cast(self):
        old = "SELECT CAST(id AS INT) AS id, name FROM users"
        new = "SELECT CAST(id AS VARCHAR) AS id, name FROM users"
        result = diff_schema(old, new)
        assert result["success"]
        type_changes = [c for c in result["changes"] if c["change_type"] == "TYPE_CHANGED"]
        assert len(type_changes) == 1
        assert type_changes[0]["severity"] == "warning"


class TestRenamedColumns:
    """Renamed columns → WARNING severity (Levenshtein distance ≤ 2)."""

    def test_single_char_rename(self):
        old = "SELECT id, user_name FROM users"
        new = "SELECT id, user_namee FROM users"  # 1 char difference
        result = diff_schema(old, new)
        assert result["success"]
        renamed = [c for c in result["changes"] if c["change_type"] == "RENAMED"]
        assert len(renamed) == 1
        assert renamed[0]["severity"] == "warning"

    def test_no_rename_for_distant_names(self):
        """Names with distance > 2 should be reported as dropped + added."""
        old = "SELECT id, first_name FROM users"
        new = "SELECT id, last_name FROM users"  # distance > 2
        result = diff_schema(old, new)
        assert result["success"]
        renamed = [c for c in result["changes"] if c["change_type"] == "RENAMED"]
        dropped = [c for c in result["changes"] if c["change_type"] == "DROPPED"]
        added = [c for c in result["changes"] if c["change_type"] == "ADDED"]
        # Should be dropped + added, not renamed
        assert len(renamed) == 0
        assert len(dropped) == 1
        assert len(added) == 1


class TestAliasedColumns:
    """Compare by alias, not source expression."""

    def test_alias_preserved(self):
        old = "SELECT user_id AS uid, name FROM users"
        new = "SELECT user_id AS uid, name FROM users"
        result = diff_schema(old, new)
        assert result["success"]
        assert len(result["changes"]) == 0

    def test_alias_changed(self):
        old = "SELECT user_id AS uid, name FROM users"
        new = "SELECT user_id AS user_identifier, name FROM users"
        result = diff_schema(old, new)
        assert result["success"]
        # uid removed, user_identifier added
        assert len(result["changes"]) >= 1


class TestUnionAll:
    """UNION ALL → schema from first branch."""

    def test_union_uses_first_branch(self):
        old = "SELECT id, name FROM users UNION ALL SELECT id, name FROM admins"
        new = "SELECT id FROM users UNION ALL SELECT id FROM admins"
        result = diff_schema(old, new)
        assert result["success"]
        dropped = [c for c in result["changes"] if c["change_type"] == "DROPPED"]
        assert len(dropped) == 1
        assert dropped[0]["column"].lower() == "name"


class TestSelectStarHandling:
    """SELECT * with and without schema_context."""

    def test_star_without_schema(self):
        old = "SELECT * FROM users"
        new = "SELECT id, name FROM users"
        result = diff_schema(old, new)
        assert result["success"]
        # * column vs explicit — should detect changes

    def test_star_with_schema(self):
        old = "SELECT * FROM users"
        new = "SELECT id, name FROM users"
        schema = {"users": {"id": "INT", "name": "VARCHAR", "email": "VARCHAR"}}
        result = diff_schema(old, new, schema_context=schema)
        assert result["success"]
        # email should be detected as dropped
        dropped = [c for c in result["changes"] if c["change_type"] == "DROPPED"]
        assert len(dropped) >= 1


class TestSummary:
    """Summary counts."""

    def test_summary_counts(self):
        old = "SELECT id, name, email FROM users"
        new = "SELECT id, phone FROM users"
        result = diff_schema(old, new)
        assert result["success"]
        s = result["summary"]
        assert s["old_column_count"] == 3
        assert s["new_column_count"] == 2
        assert s["dropped"] >= 1
        assert s["added"] >= 0


class TestEdgeCases:
    """Edge cases and error handling."""

    def test_parse_error_old(self):
        result = diff_schema(")))INVALID SQL(((", "SELECT id FROM users")
        assert result["success"] is False
        assert result["error"] is not None

    def test_parse_error_new(self):
        result = diff_schema("SELECT id FROM users", ")))INVALID SQL(((")
        assert result["success"] is False
        assert result["error"] is not None

    def test_empty_select(self):
        # Edge case — unusual but shouldn't crash
        old = "SELECT 1 AS a"
        new = "SELECT 1 AS a"
        result = diff_schema(old, new)
        assert result["success"]
        assert len(result["changes"]) == 0

    def test_cte_columns(self):
        old = "WITH cte AS (SELECT id, name FROM users) SELECT id, name FROM cte"
        new = "WITH cte AS (SELECT id FROM users) SELECT id FROM cte"
        result = diff_schema(old, new)
        assert result["success"]
        dropped = [c for c in result["changes"] if c["change_type"] == "DROPPED"]
        assert len(dropped) == 1

    def test_different_dialects(self):
        old = "SELECT id, name FROM users"
        new = "SELECT id FROM users"
        result = diff_schema(old, new, dialect="postgres")
        assert result["success"]
        assert result["has_breaking_changes"]

    def test_identical_queries(self):
        sql = "SELECT id, name, email FROM users WHERE active = TRUE"
        result = diff_schema(sql, sql)
        assert result["success"]
        assert len(result["changes"]) == 0
        assert not result["has_breaking_changes"]
