"""Tests for SQL dialect translation."""

import pytest
from altimate_engine.sql.translator import translate_sql


class TestTranslateSql:
    def test_snowflake_to_postgres(self):
        result = translate_sql(
            sql="SELECT CURRENT_TIMESTAMP()",
            source_dialect="snowflake",
            target_dialect="postgres",
        )
        assert result["success"] is True
        assert result["translated_sql"] is not None
        assert result["source_dialect"] == "snowflake"
        assert result["target_dialect"] == "postgres"

    def test_postgres_to_snowflake(self):
        result = translate_sql(
            sql="SELECT NOW()",
            source_dialect="postgres",
            target_dialect="snowflake",
        )
        assert result["success"] is True
        assert result["translated_sql"] is not None

    def test_same_dialect(self):
        result = translate_sql(
            sql="SELECT 1",
            source_dialect="snowflake",
            target_dialect="snowflake",
        )
        assert result["success"] is True

    def test_handles_any_sql_gracefully(self):
        """sqlglot is lenient — even bad SQL may parse. Verify no crash."""
        result = translate_sql(
            sql="NOT VALID SQL @@#",
            source_dialect="snowflake",
            target_dialect="postgres",
        )
        # May succeed (sqlglot is lenient) or fail — either is fine, just no crash
        assert isinstance(result["success"], bool)

    def test_preserves_logic(self):
        result = translate_sql(
            sql="SELECT a, b FROM t WHERE a > 1 ORDER BY b LIMIT 10",
            source_dialect="postgres",
            target_dialect="snowflake",
        )
        assert result["success"] is True
        translated = result["translated_sql"].upper()
        assert "LIMIT" in translated or "FETCH" in translated
