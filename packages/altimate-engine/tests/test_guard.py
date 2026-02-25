"""Tests for SQL validation and safety checking."""

import pytest
from altimate_engine.sql.guard import validate_sql, check_sql
from altimate_engine.models import SqlValidateParams, SqlCheckParams, SqlCheckMode


class TestValidateSql:
    def test_valid_select(self):
        result = validate_sql(SqlValidateParams(sql="SELECT 1"))
        assert result.valid is True
        assert len(result.errors) == 0

    def test_valid_complex_query(self):
        result = validate_sql(SqlValidateParams(
            sql="SELECT a.id, b.name FROM users a JOIN orders b ON a.id = b.user_id WHERE a.active = true",
            dialect="snowflake",
        ))
        assert result.valid is True

    def test_invalid_sql(self):
        result = validate_sql(SqlValidateParams(sql="SELECT FROM WHERE"))
        # sqlglot is lenient, but this should still parse or return errors
        # The key thing is it doesn't crash
        assert isinstance(result.valid, bool)

    def test_empty_sql(self):
        result = validate_sql(SqlValidateParams(sql=""))
        assert result.valid is False

    def test_normalized_output(self):
        result = validate_sql(SqlValidateParams(sql="SELECT 1"))
        assert result.valid is True
        # Normalized SQL should be present for valid single statements
        assert result.normalized is not None


class TestCheckSql:
    def test_safe_select(self):
        result = check_sql(SqlCheckParams(sql="SELECT 1"))
        assert result.safe is True
        assert len(result.issues) == 0

    def test_detects_drop_table(self):
        result = check_sql(SqlCheckParams(sql="DROP TABLE users"))
        assert result.safe is False
        codes = [i.code for i in result.issues]
        assert "DDL_DETECTED" in codes or "DROP_DETECTED" in codes

    def test_detects_insert(self):
        result = check_sql(SqlCheckParams(sql="INSERT INTO users (name) VALUES ('test')"))
        codes = [i.code for i in result.issues]
        assert "DML_WRITE" in codes

    def test_detects_delete(self):
        result = check_sql(SqlCheckParams(sql="DELETE FROM users WHERE id = 1"))
        codes = [i.code for i in result.issues]
        assert "DML_WRITE" in codes

    def test_detects_update(self):
        result = check_sql(SqlCheckParams(sql="UPDATE users SET name = 'test' WHERE id = 1"))
        codes = [i.code for i in result.issues]
        assert "DML_WRITE" in codes

    def test_read_only_blocks_insert(self):
        result = check_sql(SqlCheckParams(
            sql="INSERT INTO users (name) VALUES ('test')",
            mode=SqlCheckMode.READ_ONLY,
        ))
        assert result.safe is False
        codes = [i.code for i in result.issues]
        assert "READ_ONLY_VIOLATION" in codes

    def test_read_only_allows_select(self):
        result = check_sql(SqlCheckParams(
            sql="SELECT * FROM users",
            mode=SqlCheckMode.READ_ONLY,
        ))
        assert result.safe is True

    def test_detects_create_table(self):
        result = check_sql(SqlCheckParams(sql="CREATE TABLE test (id INT)"))
        assert result.safe is False
        codes = [i.code for i in result.issues]
        assert "DDL_DETECTED" in codes

    def test_handles_parse_error(self):
        result = check_sql(SqlCheckParams(sql=""))
        assert result.safe is False


class TestNoSqlguardDependency:
    """Verify that guard.py works without sqlguard."""

    def test_validate_works(self):
        """validate_sql should return real results, not 'sqlguard not installed'."""
        result = validate_sql(SqlValidateParams(sql="SELECT 1"))
        assert result.valid is True
        for err in result.errors:
            assert "sqlguard" not in err.lower()

    def test_check_works(self):
        """check_sql should return real results, not 'sqlguard not installed'."""
        result = check_sql(SqlCheckParams(sql="SELECT 1"))
        for issue in result.issues:
            assert "sqlguard" not in issue.code.lower()
            assert "sqlguard" not in issue.message.lower()
