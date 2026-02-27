"""Thin wrapper for sqlguard Rust bindings with graceful fallback."""

from __future__ import annotations

import json
import tempfile
from typing import Any

try:
    import sqlguard

    SQLGUARD_AVAILABLE = True
except ImportError:
    SQLGUARD_AVAILABLE = False

_NOT_INSTALLED_MSG = (
    "sqlguard not installed. Run: cd sqlguard/crates/sqlguard-python && "
    "PYO3_USE_ABI3_FORWARD_COMPATIBILITY=1 maturin build --release && "
    "pip install target/wheels/sqlguard-*.whl"
)


def _not_installed_result() -> dict:
    return {"success": False, "error": _NOT_INSTALLED_MSG}


def _parse_json(result: str) -> dict:
    return json.loads(result)


def _resolve_schema(
    schema_path: str, schema_context: dict[str, Any] | None
) -> tuple[str, bool]:
    """Resolve schema source.

    Returns:
        Tuple of (schema_path, should_cleanup)
    """
    if schema_path:
        return schema_path, False
    if schema_context:
        path = _write_temp_schema(schema_context)
        return path, True
    return "", False


def _write_temp_schema(schema_context: dict[str, Any]) -> str:
    """Write schema context to a temporary YAML file."""
    import yaml

    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        yaml.dump(schema_context, f)
        return f.name


def _cleanup_temp_schema(path: str) -> None:
    """Clean up a temporary schema file."""
    import os

    try:
        os.unlink(path)
    except OSError:
        pass


def guard_validate(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Validate SQL against schema using sqlguard."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.validate(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_lint(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Lint SQL for anti-patterns using sqlguard."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.lint(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_scan_safety(sql: str) -> dict:
    """Scan SQL for injection patterns and safety threats."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        result = sqlguard.scan_safety(sql)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_transpile(sql: str, from_dialect: str, to_dialect: str) -> dict:
    """Transpile SQL between dialects."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        result = sqlguard.transpile(sql, from_dialect, to_dialect)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_explain(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Explain SQL query plan, lineage, and cost signals."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.explain(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_check(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Run full analysis pipeline: validate + lint + safety + PII."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.check(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}
