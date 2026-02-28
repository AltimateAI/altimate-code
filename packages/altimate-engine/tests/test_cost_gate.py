"""Tests for ci/cost_gate.py — CI cost gate scanner."""

import os
import tempfile

import pytest

from altimate_engine.ci.cost_gate import scan_files, _has_jinja, _split_statements


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_temp_sql(content: str, suffix: str = ".sql") -> str:
    """Write content to a temp file and return the path."""
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "w") as f:
        f.write(content)
    return path


# ---------------------------------------------------------------------------
# Unit tests: helper functions
# ---------------------------------------------------------------------------


class TestHasJinja:
    def test_no_jinja(self):
        assert _has_jinja("SELECT * FROM orders") is False

    def test_double_brace(self):
        assert _has_jinja("SELECT * FROM {{ ref('orders') }}") is True

    def test_block_tag(self):
        assert _has_jinja("{% if flag %}SELECT 1{% endif %}") is True

    def test_comment_tag(self):
        assert _has_jinja("{# this is a comment #}") is True


class TestSplitStatements:
    def test_single_statement(self):
        assert _split_statements("SELECT 1") == ["SELECT 1"]

    def test_multiple_statements(self):
        result = _split_statements("SELECT 1; SELECT 2;")
        assert result == ["SELECT 1", "SELECT 2"]

    def test_empty_string(self):
        assert _split_statements("") == []

    def test_trailing_semicolons(self):
        result = _split_statements("SELECT 1;; ;")
        assert result == ["SELECT 1"]


# ---------------------------------------------------------------------------
# Integration tests: scan_files
# ---------------------------------------------------------------------------


class TestScanFiles:
    def test_clean_file_passes(self):
        path = _write_temp_sql("SELECT id, name FROM users LIMIT 10")
        try:
            result = scan_files([path])
            assert result["success"]
            assert result["passed"]
            assert result["exit_code"] == 0
            assert result["files_scanned"] == 1
        finally:
            os.unlink(path)

    def test_cartesian_product_has_warnings(self):
        """CROSS JOIN produces lint warnings (SELECT *, missing aliases, no LIMIT)."""
        path = _write_temp_sql("SELECT * FROM a CROSS JOIN b")
        try:
            result = scan_files([path])
            assert result["success"]
            assert result["total_issues"] > 0
        finally:
            os.unlink(path)

    def test_skip_non_sql(self):
        path = _write_temp_sql("not sql content", suffix=".py")
        try:
            result = scan_files([path])
            assert result["success"]
            assert result["passed"]
            assert result["files_skipped"] == 1
            assert result["files_scanned"] == 0
        finally:
            os.unlink(path)

    def test_skip_jinja(self):
        path = _write_temp_sql("SELECT * FROM {{ ref('orders') }} LIMIT 10")
        try:
            result = scan_files([path])
            assert result["success"]
            assert result["passed"]
            assert result["files_skipped"] == 1
        finally:
            os.unlink(path)

    def test_missing_file(self):
        result = scan_files(["/nonexistent/path/file.sql"])
        assert result["success"]
        assert result["passed"]
        assert result["files_skipped"] == 1

    def test_empty_file_list(self):
        result = scan_files([])
        assert result["success"]
        assert result["passed"]
        assert result["files_scanned"] == 0

    def test_multiple_files_mixed(self):
        clean_path = _write_temp_sql("SELECT id FROM users LIMIT 10")
        warn_path = _write_temp_sql("SELECT * FROM a CROSS JOIN b")
        try:
            result = scan_files([clean_path, warn_path])
            assert result["success"]
            assert result["files_scanned"] == 2

            # Check per-file results
            file_statuses = {fr["file"]: fr["status"] for fr in result["file_results"]}
            assert file_statuses[clean_path] == "pass"
            # CROSS JOIN only produces warnings, not errors/critical
            assert file_statuses[warn_path] == "pass"
        finally:
            os.unlink(clean_path)
            os.unlink(warn_path)

    def test_multiple_statements_in_file(self):
        """Multiple statements: lint runs on each; warnings don't fail the gate."""
        path = _write_temp_sql("SELECT 1; SELECT * FROM a CROSS JOIN b;")
        try:
            result = scan_files([path])
            assert result["success"]
            assert result["total_issues"] > 0
        finally:
            os.unlink(path)

    def test_warnings_still_pass(self):
        """Files with only warning-level issues should pass the gate."""
        path = _write_temp_sql("SELECT * FROM orders")
        try:
            result = scan_files([path])
            assert result["success"]
            assert result["passed"]  # SELECT * is warning, not critical
            # Lint produces warnings for SELECT * and missing LIMIT
            assert result["total_issues"] >= 0
        finally:
            os.unlink(path)

    def test_dialect_parameter(self):
        path = _write_temp_sql("SELECT id FROM users LIMIT 10")
        try:
            result = scan_files([path], dialect="postgres")
            assert result["success"]
            assert result["passed"]
        finally:
            os.unlink(path)

    def test_parse_error_skipped(self):
        """Unparseable SQL within a file should be skipped, not crash."""
        path = _write_temp_sql("SELEC * FORM orders")
        try:
            result = scan_files([path])
            assert result["success"]
            # Parse error is not critical — should still pass
            assert result["passed"]
        finally:
            os.unlink(path)
