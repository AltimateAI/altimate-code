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


# ---------------------------------------------------------------------------
# Phase 1 (P0): High-impact new capabilities
# ---------------------------------------------------------------------------


def guard_fix(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
    dialect: str = "",
) -> dict:
    """Auto-fix SQL errors via fuzzy matching and re-validation."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.fix(sql, path or "", dialect or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_check_policy(
    sql: str,
    policy_yaml: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Check SQL against YAML-based governance guardrails."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.check_policy(sql, path or "", policy_yaml)
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_complexity_score(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
    dialect: str = "",
) -> dict:
    """Score multi-dimensional complexity and estimated cloud cost."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.complexity_score(sql, path or "", dialect or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_check_semantics(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Run 10 semantic validation rules against SQL."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.check_semantics(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_generate_tests(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Generate automated SQL test cases."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.generate_tests(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Phase 2 (P1): Deeper analysis
# ---------------------------------------------------------------------------


def guard_check_equivalence(
    sql1: str,
    sql2: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Check semantic equivalence of two queries."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.check_equivalence(sql1, sql2, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_analyze_migration(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Analyze DDL migration safety (data loss, type narrowing, defaults)."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.analyze_migration(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_diff_schemas(
    schema1_path: str,
    schema2_path: str,
) -> dict:
    """Diff two schemas with breaking change detection."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        result = sqlguard.diff_schemas(schema1_path, schema2_path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_rewrite(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Suggest query optimization rewrites."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.rewrite(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_correct(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
    max_iterations: int = 5,
) -> dict:
    """Iterative propose-verify-refine correction loop."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.correct(sql, path or "", max_iterations)
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_evaluate(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Grade SQL quality on A-F scale."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.evaluate(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_estimate_cost(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
    dialect: str = "",
) -> dict:
    """Estimate per-dialect cloud cost (bytes scanned, USD)."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.estimate_cost(sql, path or "", dialect or "generic")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Phase 3 (P2): Complete coverage
# ---------------------------------------------------------------------------


def guard_classify_pii(
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Classify PII columns in schema."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.classify_pii(path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_check_query_pii(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Analyze query-level PII exposure."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.check_query_pii(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_resolve_term(
    term: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Fuzzy match business glossary term to schema elements."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.resolve_term(term, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_column_lineage(
    sql: str,
    dialect: str = "",
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Schema-aware column lineage (gated, requires init)."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.column_lineage(
                sql, dialect=dialect or "generic", schema=path or ""
            )
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_track_lineage(
    queries: list[str],
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Track lineage across multiple queries (gated, requires init)."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.track_lineage(queries, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_format_sql(sql: str, dialect: str = "") -> dict:
    """Rust-powered SQL formatting."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        result = sqlguard.format_sql(sql, dialect or "generic")
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_extract_metadata(sql: str, dialect: str = "") -> dict:
    """Extract tables, columns, functions, CTEs from SQL."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        result = sqlguard.extract_metadata(sql, dialect or "generic")
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_compare_queries(
    left_sql: str, right_sql: str, dialect: str = ""
) -> dict:
    """Structural comparison of two queries."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        result = sqlguard.compare_queries(left_sql, right_sql, dialect or "generic")
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_complete(
    sql: str,
    cursor_pos: int,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Cursor-aware SQL completion suggestions."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.complete(sql, cursor_pos, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_optimize_context(
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """5-level progressive disclosure for context window optimization."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.optimize_context(path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_optimize_for_query(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Query-aware schema reduction — prune to relevant tables/columns."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.optimize_for_query(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_prune_schema(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Filter schema to only referenced tables/columns."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.prune_schema(sql, path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_import_ddl(ddl: str, dialect: str = "") -> dict:
    """Parse CREATE TABLE DDL into schema definition."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        result = sqlguard.import_ddl(ddl, dialect or "generic")
        # import_ddl returns a Schema object; convert to dict
        if hasattr(result, "to_dict"):
            return {"success": True, "schema": result.to_dict()}
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_export_ddl(
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Export schema as CREATE TABLE DDL statements."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.export_ddl(path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        # export_ddl may return a plain string
        if isinstance(result, str):
            try:
                return _parse_json(result)
            except (json.JSONDecodeError, ValueError):
                return {"success": True, "ddl": result}
        return {"success": True, "ddl": str(result)}
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_schema_fingerprint(
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Compute SHA-256 fingerprint of schema for caching."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        path, cleanup = _resolve_schema(schema_path, schema_context)
        try:
            result = sqlguard.schema_fingerprint(path or "")
        finally:
            if cleanup:
                _cleanup_temp_schema(path)
        # schema_fingerprint returns a plain string hash
        if isinstance(result, str):
            try:
                return _parse_json(result)
            except (json.JSONDecodeError, ValueError):
                return {"success": True, "fingerprint": result}
        return {"success": True, "fingerprint": str(result)}
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_introspection_sql(
    db_type: str,
    database: str,
    schema_name: str | None = None,
) -> dict:
    """Generate INFORMATION_SCHEMA introspection queries per dialect."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        result = sqlguard.introspection_sql(db_type, database, schema_name or "")
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_parse_dbt_project(project_dir: str) -> dict:
    """Parse dbt project directory for analysis."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        result = sqlguard.parse_dbt_project(project_dir)
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_is_safe(sql: str) -> dict:
    """Quick boolean safety check."""
    if not SQLGUARD_AVAILABLE:
        return _not_installed_result()
    try:
        result = sqlguard.is_safe(sql)
        # is_safe returns a boolean
        if isinstance(result, bool):
            return {"success": True, "safe": result}
        return _parse_json(result)
    except Exception as e:
        return {"success": False, "error": str(e)}
