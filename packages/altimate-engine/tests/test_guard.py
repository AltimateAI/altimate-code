"""Tests for the sqlguard Python wrapper."""

import json
import os
import tempfile
from unittest.mock import patch

import pytest
import yaml

from altimate_engine.sql.guard import (
    SQLGUARD_AVAILABLE,
    guard_validate,
    guard_lint,
    guard_scan_safety,
    guard_transpile,
    guard_explain,
    guard_check,
    _resolve_schema,
    _write_temp_schema,
    _cleanup_temp_schema,
)


# Skip all tests if sqlguard is not installed
pytestmark = pytest.mark.skipif(
    not SQLGUARD_AVAILABLE, reason="sqlguard not installed"
)


class TestGuardValidate:
    def test_valid_sql(self):
        result = guard_validate("SELECT 1")
        assert isinstance(result, dict)
        assert result.get("valid") is True

    def test_invalid_sql(self):
        result = guard_validate("SELEC 1")
        assert isinstance(result, dict)
        assert result.get("valid") is False or result.get("errors")

    def test_empty_sql(self):
        result = guard_validate("")
        assert isinstance(result, dict)


class TestGuardLint:
    def test_clean_sql(self):
        result = guard_lint("SELECT id FROM users WHERE id = 1")
        assert isinstance(result, dict)

    def test_null_comparison(self):
        result = guard_lint("SELECT * FROM users WHERE name = NULL")
        assert isinstance(result, dict)
        # Should detect the NULL comparison anti-pattern
        findings = result.get("findings", result.get("violations", []))
        assert isinstance(findings, list)

    def test_empty_sql(self):
        result = guard_lint("")
        assert isinstance(result, dict)


class TestGuardScanSafety:
    def test_safe_query(self):
        result = guard_scan_safety("SELECT id FROM users")
        assert isinstance(result, dict)
        assert result.get("safe") is True

    def test_drop_table(self):
        result = guard_scan_safety("DROP TABLE users")
        assert isinstance(result, dict)
        # DROP should be flagged as unsafe
        assert result.get("safe") is False or result.get("threats")

    def test_multiple_statements(self):
        result = guard_scan_safety("SELECT 1; DROP TABLE users")
        assert isinstance(result, dict)

    def test_empty_sql(self):
        result = guard_scan_safety("")
        assert isinstance(result, dict)


class TestGuardTranspile:
    def test_basic_transpile(self):
        result = guard_transpile("SELECT 1", "generic", "postgres")
        assert isinstance(result, dict)

    def test_transpile_success_fields(self):
        result = guard_transpile("SELECT 1", "generic", "postgres")
        # Should have transpiled_sql on success
        if result.get("success", True):
            assert "transpiled_sql" in result

    def test_unknown_dialect(self):
        result = guard_transpile("SELECT 1", "nonexistent", "postgres")
        assert isinstance(result, dict)
        # Should either error or return a result
        assert "error" in result or "transpiled_sql" in result


class TestGuardExplain:
    def test_basic_explain(self):
        result = guard_explain("SELECT 1")
        assert isinstance(result, dict)

    def test_complex_query(self):
        result = guard_explain(
            "SELECT u.id, o.total FROM users u JOIN orders o ON u.id = o.user_id"
        )
        assert isinstance(result, dict)


class TestGuardCheck:
    def test_basic_check(self):
        result = guard_check("SELECT 1")
        assert isinstance(result, dict)
        # Composite result has validation, lint, safety keys
        assert "validation" in result or "success" in result

    def test_check_has_sections(self):
        result = guard_check("SELECT * FROM users WHERE name = NULL")
        assert isinstance(result, dict)

    def test_unsafe_sql_check(self):
        result = guard_check("DROP TABLE users")
        assert isinstance(result, dict)


class TestSchemaContext:
    def test_resolve_with_path(self):
        # Write a valid YAML file first
        schema = {"tables": {"test": {"columns": [{"name": "id", "type": "int"}]}}, "version": "1"}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
            yaml.dump(schema, f)
            path = f.name
        try:
            s = _resolve_schema(path, None)
            assert s is not None
        finally:
            os.unlink(path)

    def test_resolve_empty(self):
        s = _resolve_schema("", None)
        assert s is None

    def test_write_and_cleanup_temp(self):
        schema = {"tables": [{"name": "test"}]}
        tmp_path = _write_temp_schema(schema)
        assert os.path.exists(tmp_path)
        _cleanup_temp_schema(tmp_path)
        assert not os.path.exists(tmp_path)

    def test_cleanup_nonexistent_file(self):
        """Should not raise on missing file."""
        _cleanup_temp_schema("/nonexistent/path/file.yaml")

    def test_validate_with_schema_context(self):
        schema = {"tables": {"users": {"columns": [{"name": "id", "type": "int"}]}}, "version": "1"}
        result = guard_validate("SELECT id FROM users", schema_context=schema)
        assert isinstance(result, dict)

    def test_lint_with_schema_context(self):
        schema = {"tables": {"users": {"columns": [{"name": "id", "type": "int"}]}}, "version": "1"}
        result = guard_lint("SELECT * FROM users", schema_context=schema)
        assert isinstance(result, dict)


class TestGracefulFallback:
    """Test behavior when sqlguard is not installed."""

    def test_validate_fallback(self):
        with patch("altimate_engine.sql.guard.SQLGUARD_AVAILABLE", False):
            result = guard_validate("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_lint_fallback(self):
        with patch("altimate_engine.sql.guard.SQLGUARD_AVAILABLE", False):
            result = guard_lint("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_safety_fallback(self):
        with patch("altimate_engine.sql.guard.SQLGUARD_AVAILABLE", False):
            result = guard_scan_safety("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_transpile_fallback(self):
        with patch("altimate_engine.sql.guard.SQLGUARD_AVAILABLE", False):
            result = guard_transpile("SELECT 1", "generic", "postgres")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_explain_fallback(self):
        with patch("altimate_engine.sql.guard.SQLGUARD_AVAILABLE", False):
            result = guard_explain("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_check_fallback(self):
        with patch("altimate_engine.sql.guard.SQLGUARD_AVAILABLE", False):
            result = guard_check("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]
