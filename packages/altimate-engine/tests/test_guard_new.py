"""Tests for the new altimate-core Python wrapper functions (Phases 1-3).

Updated for new altimate-core API: Schema objects instead of path strings,
dicts returned directly, renamed/removed params.
"""

import json
import os
import tempfile
from unittest.mock import patch

import pytest
import yaml

from altimate_engine.sql.guard import (
    ALTIMATE_CORE_AVAILABLE,
    # Phase 1 (P0)
    guard_fix,
    guard_check_policy,
    guard_check_semantics,
    guard_generate_tests,
    # Phase 2 (P1)
    guard_check_equivalence,
    guard_analyze_migration,
    guard_diff_schemas,
    guard_rewrite,
    guard_correct,
    guard_evaluate,
    # Phase 3 (P2)
    guard_classify_pii,
    guard_check_query_pii,
    guard_resolve_term,
    guard_column_lineage,
    guard_track_lineage,
    guard_format_sql,
    guard_extract_metadata,
    guard_compare_queries,
    guard_complete,
    guard_optimize_context,
    guard_optimize_for_query,
    guard_prune_schema,
    guard_import_ddl,
    guard_export_ddl,
    guard_schema_fingerprint,
    guard_introspection_sql,
    guard_parse_dbt_project,
    guard_is_safe,
)


# Schema context in the format altimate-core expects
SCHEMA_CTX = {
    "tables": {
        "users": {
            "columns": [
                {"name": "id", "type": "int"},
                {"name": "name", "type": "varchar"},
                {"name": "email", "type": "varchar"},
            ]
        },
        "orders": {
            "columns": [
                {"name": "id", "type": "int"},
                {"name": "user_id", "type": "int"},
                {"name": "total", "type": "decimal"},
            ]
        },
    },
    "version": "1",
}

# Minimal schema for single-table tests
SIMPLE_SCHEMA = {
    "tables": {
        "users": {
            "columns": [
                {"name": "id", "type": "int"},
                {"name": "name", "type": "varchar"},
            ]
        }
    },
    "version": "1",
}


# Skip all tests if altimate-core is not installed
pytestmark = pytest.mark.skipif(
    not ALTIMATE_CORE_AVAILABLE, reason="altimate-core not installed"
)


# ---------------------------------------------------------------------------
# Phase 1 (P0): High-impact new capabilities
# ---------------------------------------------------------------------------


class TestGuardFix:
    def test_fix_broken_sql(self):
        result = guard_fix("SELCT * FORM orders")
        assert isinstance(result, dict)

    def test_fix_valid_sql(self):
        result = guard_fix("SELECT * FROM orders")
        assert isinstance(result, dict)

    def test_fix_with_max_iterations(self):
        result = guard_fix("SELECT 1", max_iterations=3)
        assert isinstance(result, dict)

    def test_fix_with_schema_context(self):
        result = guard_fix("SELCT id FORM orders", schema_context=SCHEMA_CTX)
        assert isinstance(result, dict)

    def test_fix_empty_sql(self):
        result = guard_fix("")
        assert isinstance(result, dict)


class TestGuardCheckPolicy:
    def test_basic_policy(self):
        policy = '{"rules": [{"no_select_star": true}]}'
        result = guard_check_policy("SELECT * FROM users", policy)
        assert isinstance(result, dict)

    def test_empty_policy(self):
        result = guard_check_policy("SELECT 1", "")
        assert isinstance(result, dict)

    def test_policy_with_schema_context(self):
        result = guard_check_policy("SELECT * FROM users", "{}", schema_context=SIMPLE_SCHEMA)
        assert isinstance(result, dict)



class TestGuardCheckSemantics:
    def test_basic_semantics(self):
        result = guard_check_semantics("SELECT id FROM users WHERE id = 1")
        assert isinstance(result, dict)

    def test_null_comparison(self):
        result = guard_check_semantics("SELECT * FROM users WHERE name = NULL")
        assert isinstance(result, dict)

    def test_with_schema_context(self):
        result = guard_check_semantics("SELECT id FROM users", schema_context=SIMPLE_SCHEMA)
        assert isinstance(result, dict)

    def test_empty_sql(self):
        result = guard_check_semantics("")
        assert isinstance(result, dict)


class TestGuardGenerateTests:
    def test_basic_testgen(self):
        result = guard_generate_tests("SELECT id, name FROM users WHERE active = true")
        assert isinstance(result, dict)

    def test_complex_query_testgen(self):
        result = guard_generate_tests(
            "SELECT u.id, COUNT(o.id) FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.id"
        )
        assert isinstance(result, dict)

    def test_with_schema_context(self):
        result = guard_generate_tests("SELECT id, name FROM users", schema_context=SIMPLE_SCHEMA)
        assert isinstance(result, dict)

    def test_empty_sql(self):
        result = guard_generate_tests("")
        assert isinstance(result, dict)


# ---------------------------------------------------------------------------
# Phase 2 (P1): Deeper analysis
# ---------------------------------------------------------------------------


class TestGuardCheckEquivalence:
    def test_same_queries(self):
        result = guard_check_equivalence("SELECT 1", "SELECT 1")
        assert isinstance(result, dict)

    def test_different_queries(self):
        result = guard_check_equivalence(
            "SELECT id FROM users",
            "SELECT id FROM users WHERE active = true",
        )
        assert isinstance(result, dict)

    def test_reordered_columns(self):
        result = guard_check_equivalence(
            "SELECT id, name FROM users",
            "SELECT name, id FROM users",
        )
        assert isinstance(result, dict)


class TestGuardAnalyzeMigration:
    def test_basic_migration(self):
        result = guard_analyze_migration(
            "CREATE TABLE users (id INT);",
            "CREATE TABLE users (id INT, email VARCHAR(255));",
        )
        assert isinstance(result, dict)

    def test_drop_column(self):
        result = guard_analyze_migration(
            "CREATE TABLE users (id INT, email VARCHAR(255));",
            "CREATE TABLE users (id INT);",
        )
        assert isinstance(result, dict)

    def test_empty_sql(self):
        result = guard_analyze_migration("", "")
        assert isinstance(result, dict)


class TestGuardDiffSchemas:
    def test_diff_same_schema(self):
        schema = {"tables": {"users": {"columns": [{"name": "id", "type": "int"}]}}, "version": "1"}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f1:
            yaml.dump(schema, f1)
            path1 = f1.name
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f2:
            yaml.dump(schema, f2)
            path2 = f2.name
        try:
            result = guard_diff_schemas(path1, path2)
            assert isinstance(result, dict)
        finally:
            os.unlink(path1)
            os.unlink(path2)

    def test_diff_different_schemas(self):
        schema1 = {"tables": {"users": {"columns": [{"name": "id", "type": "int"}]}}, "version": "1"}
        schema2 = {"tables": {"users": {"columns": [{"name": "id", "type": "int"}, {"name": "email", "type": "varchar"}]}}, "version": "1"}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f1:
            yaml.dump(schema1, f1)
            path1 = f1.name
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f2:
            yaml.dump(schema2, f2)
            path2 = f2.name
        try:
            result = guard_diff_schemas(path1, path2)
            assert isinstance(result, dict)
        finally:
            os.unlink(path1)
            os.unlink(path2)

    def test_diff_with_context(self):
        s1 = {"tables": {"users": {"columns": [{"name": "id", "type": "int"}]}}, "version": "1"}
        s2 = {"tables": {"users": {"columns": [{"name": "id", "type": "int"}, {"name": "name", "type": "varchar"}]}}, "version": "1"}
        result = guard_diff_schemas(schema1_context=s1, schema2_context=s2)
        assert isinstance(result, dict)


class TestGuardRewrite:
    def test_basic_rewrite(self):
        result = guard_rewrite("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)")
        assert isinstance(result, dict)

    def test_simple_query(self):
        result = guard_rewrite("SELECT 1")
        assert isinstance(result, dict)

    def test_empty_sql(self):
        result = guard_rewrite("")
        assert isinstance(result, dict)


class TestGuardCorrect:
    def test_broken_sql(self):
        result = guard_correct("SELCT * FORM orders")
        assert isinstance(result, dict)

    def test_valid_sql(self):
        result = guard_correct("SELECT * FROM orders")
        assert isinstance(result, dict)

    def test_empty_sql(self):
        result = guard_correct("")
        assert isinstance(result, dict)


class TestGuardEvaluate:
    def test_basic_evaluate(self):
        result = guard_evaluate("SELECT id FROM users WHERE id = 1")
        assert isinstance(result, dict)

    def test_poor_query(self):
        result = guard_evaluate("SELECT * FROM users, orders")
        assert isinstance(result, dict)

    def test_empty_sql(self):
        result = guard_evaluate("")
        assert isinstance(result, dict)



# ---------------------------------------------------------------------------
# Phase 3 (P2): Complete coverage
# ---------------------------------------------------------------------------


class TestGuardClassifyPii:
    def test_with_schema_context(self):
        schema = {
            "tables": {
                "users": {
                    "columns": [
                        {"name": "id", "type": "int"},
                        {"name": "email", "type": "varchar"},
                        {"name": "ssn", "type": "varchar"},
                    ]
                }
            },
            "version": "1",
        }
        result = guard_classify_pii(schema_context=schema)
        assert isinstance(result, dict)

    def test_empty_schema(self):
        result = guard_classify_pii()
        assert isinstance(result, dict)


class TestGuardCheckQueryPii:
    def test_basic_pii(self):
        result = guard_check_query_pii("SELECT email, ssn FROM users")
        assert isinstance(result, dict)

    def test_no_pii(self):
        result = guard_check_query_pii("SELECT id, count FROM stats")
        assert isinstance(result, dict)

    def test_empty_sql(self):
        result = guard_check_query_pii("")
        assert isinstance(result, dict)


class TestGuardResolveTerm:
    def test_basic_resolve(self):
        result = guard_resolve_term("customer")
        assert isinstance(result, dict)
        assert "matches" in result

    def test_with_schema_context(self):
        schema = {"tables": {"customers": {"columns": [{"name": "id", "type": "int"}]}}, "version": "1"}
        result = guard_resolve_term("customer", schema_context=schema)
        assert isinstance(result, dict)
        assert "matches" in result

    def test_empty_term(self):
        result = guard_resolve_term("")
        assert isinstance(result, dict)
        assert "matches" in result


class TestGuardColumnLineage:
    def test_basic_lineage(self):
        result = guard_column_lineage("SELECT id FROM users")
        assert isinstance(result, dict)

    def test_join_lineage(self):
        result = guard_column_lineage(
            "SELECT u.id, o.total FROM users u JOIN orders o ON u.id = o.user_id"
        )
        assert isinstance(result, dict)

    def test_with_dialect(self):
        result = guard_column_lineage("SELECT 1", dialect="snowflake")
        assert isinstance(result, dict)


class TestGuardTrackLineage:
    def test_basic_tracking(self):
        result = guard_track_lineage(["SELECT id FROM users", "SELECT user_id FROM orders"])
        assert isinstance(result, dict)

    def test_single_query(self):
        result = guard_track_lineage(["SELECT 1"])
        assert isinstance(result, dict)

    def test_empty_list(self):
        result = guard_track_lineage([])
        assert isinstance(result, dict)


class TestGuardFormatSql:
    def test_basic_format(self):
        result = guard_format_sql("select id,name from users where id=1")
        assert isinstance(result, dict)

    def test_with_dialect(self):
        result = guard_format_sql("SELECT 1", dialect="postgres")
        assert isinstance(result, dict)

    def test_empty_sql(self):
        result = guard_format_sql("")
        assert isinstance(result, dict)


class TestGuardExtractMetadata:
    def test_basic_metadata(self):
        result = guard_extract_metadata("SELECT id, name FROM users WHERE active = true")
        assert isinstance(result, dict)

    def test_with_cte(self):
        result = guard_extract_metadata(
            "WITH active_users AS (SELECT id FROM users WHERE active = true) "
            "SELECT id FROM active_users"
        )
        assert isinstance(result, dict)

    def test_empty_sql(self):
        result = guard_extract_metadata("")
        assert isinstance(result, dict)


class TestGuardCompareQueries:
    def test_same_queries(self):
        result = guard_compare_queries("SELECT 1", "SELECT 1")
        assert isinstance(result, dict)

    def test_different_queries(self):
        result = guard_compare_queries("SELECT id FROM users", "SELECT name FROM orders")
        assert isinstance(result, dict)

    def test_with_dialect(self):
        result = guard_compare_queries("SELECT 1", "SELECT 1", dialect="postgres")
        assert isinstance(result, dict)


class TestGuardComplete:
    def test_basic_complete(self):
        result = guard_complete("SELECT ", 7)
        assert isinstance(result, dict)

    def test_with_schema_context(self):
        result = guard_complete("SELECT  FROM users", 7, schema_context=SIMPLE_SCHEMA)
        assert isinstance(result, dict)

    def test_zero_cursor(self):
        result = guard_complete("SELECT 1", 0)
        assert isinstance(result, dict)


class TestGuardOptimizeContext:
    def test_with_schema_context(self):
        result = guard_optimize_context(schema_context=SCHEMA_CTX)
        assert isinstance(result, dict)

    def test_empty_schema(self):
        result = guard_optimize_context()
        assert isinstance(result, dict)


class TestGuardOptimizeForQuery:
    def test_basic_optimize(self):
        result = guard_optimize_for_query("SELECT id FROM users")
        assert isinstance(result, dict)

    def test_with_schema_context(self):
        result = guard_optimize_for_query("SELECT id FROM users", schema_context=SCHEMA_CTX)
        assert isinstance(result, dict)


class TestGuardPruneSchema:
    def test_basic_prune(self):
        result = guard_prune_schema("SELECT id FROM users")
        assert isinstance(result, dict)

    def test_with_schema_context(self):
        result = guard_prune_schema("SELECT id FROM users", schema_context=SCHEMA_CTX)
        assert isinstance(result, dict)


class TestGuardImportDdl:
    def test_basic_import(self):
        result = guard_import_ddl("CREATE TABLE users (id INT, name VARCHAR(255))")
        assert isinstance(result, dict)

    def test_with_dialect(self):
        result = guard_import_ddl(
            "CREATE TABLE users (id INT, name VARCHAR(255))", dialect="postgres"
        )
        assert isinstance(result, dict)

    def test_empty_ddl(self):
        result = guard_import_ddl("")
        assert isinstance(result, dict)


class TestGuardExportDdl:
    def test_with_schema_context(self):
        result = guard_export_ddl(schema_context=SIMPLE_SCHEMA)
        assert isinstance(result, dict)

    def test_empty_schema(self):
        result = guard_export_ddl()
        assert isinstance(result, dict)


class TestGuardSchemaFingerprint:
    def test_with_schema_context(self):
        result = guard_schema_fingerprint(schema_context=SIMPLE_SCHEMA)
        assert isinstance(result, dict)

    def test_empty_schema(self):
        result = guard_schema_fingerprint()
        assert isinstance(result, dict)


class TestGuardIntrospectionSql:
    def test_basic_introspection(self):
        result = guard_introspection_sql("postgres", "mydb")
        assert isinstance(result, dict)

    def test_with_schema_name(self):
        result = guard_introspection_sql("snowflake", "mydb", schema_name="public")
        assert isinstance(result, dict)

    def test_bigquery(self):
        result = guard_introspection_sql("bigquery", "myproject")
        assert isinstance(result, dict)


class TestGuardParseDbtProject:
    def test_nonexistent_dir(self):
        result = guard_parse_dbt_project("/nonexistent/dbt/project")
        assert isinstance(result, dict)

    def test_empty_string(self):
        result = guard_parse_dbt_project("")
        assert isinstance(result, dict)


class TestGuardIsSafe:
    def test_safe_query(self):
        result = guard_is_safe("SELECT 1")
        assert isinstance(result, dict)
        if result.get("success"):
            assert result.get("safe") is True

    def test_unsafe_query(self):
        result = guard_is_safe("DROP TABLE users")
        assert isinstance(result, dict)

    def test_injection_attempt(self):
        result = guard_is_safe("SELECT 1; DROP TABLE users --")
        assert isinstance(result, dict)

    def test_empty_sql(self):
        result = guard_is_safe("")
        assert isinstance(result, dict)


# ---------------------------------------------------------------------------
# Graceful Fallback Tests (when altimate-core is not installed)
# ---------------------------------------------------------------------------


class TestGracefulFallbackNew:
    """Test all new functions return proper fallback when altimate-core is not installed."""

    # Phase 1 (P0)

    def test_fix_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_fix("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_check_policy_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_check_policy("SELECT 1", "{}")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_check_semantics_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_check_semantics("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_generate_tests_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_generate_tests("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    # Phase 2 (P1)

    def test_check_equivalence_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_check_equivalence("SELECT 1", "SELECT 2")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_analyze_migration_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_analyze_migration("CREATE TABLE t (id INT);", "CREATE TABLE t (id INT, x INT);")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_diff_schemas_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_diff_schemas("/a.yaml", "/b.yaml")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_rewrite_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_rewrite("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_correct_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_correct("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_evaluate_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_evaluate("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    # Phase 3 (P2)

    def test_classify_pii_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_classify_pii()
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_check_query_pii_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_check_query_pii("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_resolve_term_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_resolve_term("customer")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_column_lineage_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_column_lineage("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_track_lineage_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_track_lineage(["SELECT 1"])
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_format_sql_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_format_sql("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_extract_metadata_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_extract_metadata("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_compare_queries_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_compare_queries("SELECT 1", "SELECT 2")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_complete_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_complete("SELECT ", 7)
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_optimize_context_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_optimize_context()
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_optimize_for_query_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_optimize_for_query("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_prune_schema_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_prune_schema("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_import_ddl_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_import_ddl("CREATE TABLE t (id INT)")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_export_ddl_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_export_ddl()
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_schema_fingerprint_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_schema_fingerprint()
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_introspection_sql_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_introspection_sql("postgres", "mydb")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_parse_dbt_project_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_parse_dbt_project("/some/dir")
            assert result["success"] is False
            assert "not installed" in result["error"]

    def test_is_safe_fallback(self):
        with patch("altimate_engine.sql.guard.ALTIMATE_CORE_AVAILABLE", False):
            result = guard_is_safe("SELECT 1")
            assert result["success"] is False
            assert "not installed" in result["error"]
