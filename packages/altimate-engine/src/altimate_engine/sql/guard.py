"""Thin wrapper for altimate-core Rust bindings with graceful fallback.

altimate-core functions return dicts directly and accept Schema objects
instead of file path strings.
"""

from __future__ import annotations

import json
import re
import tempfile
from typing import Any

try:
    import altimate_core

    ALTIMATE_CORE_AVAILABLE = True
except ImportError:
    ALTIMATE_CORE_AVAILABLE = False

_NOT_INSTALLED_MSG = "altimate-core not installed. Run: pip install altimate-core"


def _not_installed_result() -> dict:
    return {"success": False, "error": _NOT_INSTALLED_MSG}


def _resolve_schema(
    schema_path: str, schema_context: dict[str, Any] | None
) -> "altimate_core.Schema | None":
    """Build a altimate_core.Schema from a YAML file path or an inline dict.

    Returns None when neither source is provided.
    """
    if schema_path:
        return altimate_core.Schema.from_yaml_file(schema_path)
    if schema_context:
        return altimate_core.Schema.from_json(json.dumps(schema_context))
    return None


def _empty_schema() -> "altimate_core.Schema":
    """Return a minimal empty Schema for calls that require one."""
    return altimate_core.Schema.from_ddl("CREATE TABLE _empty_ (id INT);")


# Keep old helpers around for backwards compat in tests
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


def _schema_or_empty(
    schema_path: str, schema_context: dict[str, Any] | None
) -> "altimate_core.Schema":
    """Resolve schema, falling back to an empty Schema if none provided."""
    s = _resolve_schema(schema_path, schema_context)
    return s if s is not None else _empty_schema()


# ---------------------------------------------------------------------------
# Original 6 functions (updated for new API)
# ---------------------------------------------------------------------------


def guard_validate(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Validate SQL against schema using altimate_core."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.validate(sql, schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_lint(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Lint SQL for anti-patterns using altimate_core."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.lint(sql, schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_scan_safety(sql: str) -> dict:
    """Scan SQL for injection patterns and safety threats."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        return altimate_core.scan_sql(sql)
    except Exception as e:
        return {"success": False, "error": str(e)}


def _preprocess_iff(sql: str) -> str:
    """Iteratively convert Snowflake IFF(cond, a, b) → CASE WHEN cond THEN a ELSE b END."""
    pattern = r"\bIFF\s*\(([^,()]+),\s*([^,()]+),\s*([^()]+)\)"
    for _ in range(10):
        new_sql = re.sub(
            pattern, r"CASE WHEN \1 THEN \2 ELSE \3 END", sql, flags=re.IGNORECASE
        )
        if new_sql == sql:
            break
        sql = new_sql
    return sql


def _postprocess_qualify(sql: str) -> str:
    """Wrap QUALIFY clause into outer SELECT for targets that lack native support."""
    m = re.search(
        r"\bQUALIFY\b\s+(.+?)(?=\s*(?:LIMIT\s+\d|ORDER\s+BY|;|$))",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    if not m:
        return sql
    qualify_expr = m.group(1).strip()
    base_sql = sql[: m.start()].rstrip()
    suffix = sql[m.end() :].strip()
    wrapped = f"SELECT * FROM ({base_sql}) AS _qualify WHERE {qualify_expr}"
    return f"{wrapped} {suffix}".strip() if suffix else wrapped


def guard_transpile(sql: str, from_dialect: str, to_dialect: str) -> dict:
    """Transpile SQL between dialects with IFF/QUALIFY pre/post-processing."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        processed = _preprocess_iff(sql)
        result = altimate_core.transpile(processed, from_dialect, to_dialect)
        target_lower = to_dialect.lower()
        if target_lower in ("bigquery", "databricks", "spark", "trino"):
            translated = result.get("sql") or result.get("translated_sql", "")
            if translated and "QUALIFY" in translated.upper():
                translated = _postprocess_qualify(translated)
                if "sql" in result:
                    result["sql"] = translated
                else:
                    result["translated_sql"] = translated
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_explain(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Explain SQL query plan, lineage, and cost signals."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.explain(sql, schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_check(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Run full analysis pipeline: validate + lint + safety.

    altimate_core.check was removed; this composes validate + lint + scan_sql.
    """
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        validation = altimate_core.validate(sql, schema)
        lint_result = altimate_core.lint(sql, schema)
        safety = altimate_core.scan_sql(sql)
        return {
            "validation": validation,
            "lint": lint_result,
            "safety": safety,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Phase 1 (P0): High-impact new capabilities
# ---------------------------------------------------------------------------


def guard_fix(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
    max_iterations: int = 5,
) -> dict:
    """Auto-fix SQL errors via fuzzy matching and re-validation."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.fix(sql, schema, max_iterations=max_iterations)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_check_policy(
    sql: str,
    policy_json: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Check SQL against JSON-based governance guardrails."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.check_policy(sql, schema, policy_json)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_check_semantics(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Run 10 semantic validation rules against SQL."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.check_semantics(sql, schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_generate_tests(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Generate automated SQL test cases."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.generate_tests(sql, schema)
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
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.check_equivalence(sql1, sql2, schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_analyze_migration(
    old_ddl: str,
    new_ddl: str,
    dialect: str = "",
) -> dict:
    """Analyze DDL migration safety (data loss, type narrowing, defaults)."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        return altimate_core.analyze_migration(old_ddl, new_ddl, dialect or "generic")
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_diff_schemas(
    schema1_path: str = "",
    schema2_path: str = "",
    schema1_context: dict[str, Any] | None = None,
    schema2_context: dict[str, Any] | None = None,
) -> dict:
    """Diff two schemas with breaking change detection."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        s1 = _schema_or_empty(schema1_path, schema1_context)
        s2 = _schema_or_empty(schema2_path, schema2_context)
        return altimate_core.diff_schemas(s1, s2)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_rewrite(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Suggest query optimization rewrites."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.rewrite(sql, schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_correct(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Iterative propose-verify-refine correction loop."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.correct(sql, schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_evaluate(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Grade SQL quality on A-F scale."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.evaluate(sql, schema)
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
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.classify_pii(schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_check_query_pii(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Analyze query-level PII exposure."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.check_query_pii(sql, schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_resolve_term(
    term: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Fuzzy match business glossary term to schema elements."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        matches = altimate_core.resolve_term(term, schema)
        return {"matches": matches}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _ensure_init() -> None:
    """Lazily initialize altimate-core SDK for gated functions (lineage, etc.).

    Reads credentials from ~/.altimate/altimate.json if present.
    No-op if already initialized or if config file is missing.
    """
    global _SDK_INITIALIZED
    if _SDK_INITIALIZED:
        return
    try:
        altimate_core.init()
        _SDK_INITIALIZED = True
    except Exception:
        # init() failed — gated functions will raise at call time
        pass


_SDK_INITIALIZED = False


def guard_column_lineage(
    sql: str,
    dialect: str = "",
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
    default_database: str = "",
    default_schema: str = "",
) -> dict:
    """Schema-aware column lineage (requires altimate_core.init)."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        _ensure_init()
        schema = _resolve_schema(schema_path, schema_context)
        return altimate_core.column_lineage(
            sql,
            dialect=dialect or "generic",
            schema=schema,
            default_database=default_database or None,
            default_schema=default_schema or None,
        )
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_track_lineage(
    queries: list[str],
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Track lineage across multiple queries (requires altimate_core.init)."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        _ensure_init()
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.track_lineage(queries, schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_format_sql(sql: str, dialect: str = "") -> dict:
    """Rust-powered SQL formatting."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        return altimate_core.format_sql(sql, dialect or "generic")
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_extract_metadata(sql: str, dialect: str = "") -> dict:
    """Extract tables, columns, functions, CTEs from SQL."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        return altimate_core.extract_metadata(sql, dialect or "generic")
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_compare_queries(left_sql: str, right_sql: str, dialect: str = "") -> dict:
    """Structural comparison of two queries."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        return altimate_core.compare_queries(left_sql, right_sql, dialect or "generic")
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_complete(
    sql: str,
    cursor_pos: int,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Cursor-aware SQL completion suggestions."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.complete(sql, cursor_pos, schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_optimize_context(
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """5-level progressive disclosure for context window optimization."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.optimize_context(schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_optimize_for_query(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Query-aware schema reduction — prune to relevant tables/columns."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.optimize_for_query(sql, schema)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_prune_schema(
    sql: str,
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Filter schema to only referenced tables/columns."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        return altimate_core.prune_schema(schema, sql)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_import_ddl(ddl: str, dialect: str = "") -> dict:
    """Parse CREATE TABLE DDL into schema definition."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        result = altimate_core.import_ddl(ddl, dialect or "generic")
        # import_ddl returns a Schema object; convert to dict
        if hasattr(result, "to_dict"):
            return {"success": True, "schema": result.to_dict()}
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_export_ddl(
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Export schema as CREATE TABLE DDL statements."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        result = altimate_core.export_ddl(schema)
        # export_ddl returns a plain string
        if isinstance(result, str):
            return {"success": True, "ddl": result}
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_schema_fingerprint(
    schema_path: str = "",
    schema_context: dict[str, Any] | None = None,
) -> dict:
    """Compute SHA-256 fingerprint of schema for caching."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        schema = _schema_or_empty(schema_path, schema_context)
        result = altimate_core.schema_fingerprint(schema)
        # schema_fingerprint returns a plain string hash
        if isinstance(result, str):
            return {"success": True, "fingerprint": result}
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_introspection_sql(
    db_type: str,
    database: str,
    schema_name: str | None = None,
) -> dict:
    """Generate INFORMATION_SCHEMA introspection queries per dialect."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        return altimate_core.introspection_sql(db_type, database, schema_name)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_parse_dbt_project(project_dir: str) -> dict:
    """Parse dbt project directory for analysis."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        return altimate_core.parse_dbt_project(project_dir)
    except Exception as e:
        return {"success": False, "error": str(e)}


def guard_is_safe(sql: str) -> dict:
    """Quick boolean safety check."""
    if not ALTIMATE_CORE_AVAILABLE:
        return _not_installed_result()
    try:
        result = altimate_core.is_safe(sql)
        # is_safe returns a boolean
        if isinstance(result, bool):
            return {"success": True, "safe": result}
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}
