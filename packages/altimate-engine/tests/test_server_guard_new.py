"""Tests for new sqlguard JSON-RPC server dispatch (Phases 1-3).

Updated for new sqlguard API: Schema objects, renamed params.
"""

import os
import tempfile

import pytest
import yaml

from altimate_engine.models import JsonRpcRequest
from altimate_engine.server import dispatch
from altimate_engine.sql.guard import SQLGUARD_AVAILABLE


# Schema context in the format sqlguard expects
SCHEMA_CTX = {
    "tables": {
        "users": {
            "columns": [
                {"name": "id", "type": "int"},
                {"name": "name", "type": "varchar"},
            ]
        },
        "orders": {
            "columns": [
                {"name": "id", "type": "int"},
                {"name": "user_id", "type": "int"},
            ]
        },
    },
    "version": "1",
}


# Skip all tests if sqlguard is not installed
pytestmark = pytest.mark.skipif(
    not SQLGUARD_AVAILABLE, reason="sqlguard not installed"
)


# ---------------------------------------------------------------------------
# Phase 1 (P0): High-impact new capabilities
# ---------------------------------------------------------------------------


class TestSqlGuardFixDispatch:
    def test_basic_fix(self):
        request = JsonRpcRequest(
            method="sqlguard.fix",
            params={"sql": "SELCT * FORM orders"},
            id=100,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result
        assert "success" in response.result

    def test_fix_with_max_iterations(self):
        request = JsonRpcRequest(
            method="sqlguard.fix",
            params={"sql": "SELCT 1", "max_iterations": 3},
            id=101,
        )
        response = dispatch(request)
        assert response.error is None

    def test_fix_with_schema_context(self):
        request = JsonRpcRequest(
            method="sqlguard.fix",
            params={"sql": "SELCT id FORM orders", "schema_context": SCHEMA_CTX},
            id=102,
        )
        response = dispatch(request)
        assert response.error is None


class TestSqlGuardPolicyDispatch:
    def test_basic_policy(self):
        request = JsonRpcRequest(
            method="sqlguard.policy",
            params={"sql": "SELECT * FROM users", "policy_json": '{"rules": []}'},
            id=110,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result

    def test_empty_policy(self):
        request = JsonRpcRequest(
            method="sqlguard.policy",
            params={"sql": "SELECT 1", "policy_json": ""},
            id=111,
        )
        response = dispatch(request)
        assert response.error is None



class TestSqlGuardSemanticsDispatch:
    def test_basic_semantics(self):
        request = JsonRpcRequest(
            method="sqlguard.semantics",
            params={"sql": "SELECT * FROM users WHERE name = NULL"},
            id=130,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result

    def test_with_schema_context(self):
        request = JsonRpcRequest(
            method="sqlguard.semantics",
            params={"sql": "SELECT id FROM users", "schema_context": SCHEMA_CTX},
            id=131,
        )
        response = dispatch(request)
        assert response.error is None


class TestSqlGuardTestgenDispatch:
    def test_basic_testgen(self):
        request = JsonRpcRequest(
            method="sqlguard.testgen",
            params={"sql": "SELECT id, name FROM users WHERE active = true"},
            id=140,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


# ---------------------------------------------------------------------------
# Phase 2 (P1): Deeper analysis
# ---------------------------------------------------------------------------


class TestSqlGuardEquivalenceDispatch:
    def test_basic_equivalence(self):
        request = JsonRpcRequest(
            method="sqlguard.equivalence",
            params={"sql1": "SELECT 1", "sql2": "SELECT 1"},
            id=200,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result

    def test_different_queries(self):
        request = JsonRpcRequest(
            method="sqlguard.equivalence",
            params={"sql1": "SELECT id FROM users", "sql2": "SELECT name FROM users"},
            id=201,
        )
        response = dispatch(request)
        assert response.error is None


class TestSqlGuardMigrationDispatch:
    def test_basic_migration(self):
        request = JsonRpcRequest(
            method="sqlguard.migration",
            params={
                "old_ddl": "CREATE TABLE users (id INT);",
                "new_ddl": "CREATE TABLE users (id INT, email VARCHAR(255));",
            },
            id=210,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardSchemaDiffDispatch:
    def test_basic_diff(self):
        schema1 = {"tables": {"users": {"columns": [{"name": "id", "type": "int"}]}}, "version": "1"}
        schema2 = {"tables": {"users": {"columns": [{"name": "id", "type": "int"}, {"name": "email", "type": "varchar"}]}}, "version": "1"}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f1:
            yaml.dump(schema1, f1)
            path1 = f1.name
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f2:
            yaml.dump(schema2, f2)
            path2 = f2.name
        try:
            request = JsonRpcRequest(
                method="sqlguard.schema_diff",
                params={"schema1_path": path1, "schema2_path": path2},
                id=220,
            )
            response = dispatch(request)
            assert response.error is None
            assert "data" in response.result
        finally:
            os.unlink(path1)
            os.unlink(path2)

    def test_diff_with_context(self):
        s1 = {"tables": {"users": {"columns": [{"name": "id", "type": "int"}]}}, "version": "1"}
        s2 = {"tables": {"users": {"columns": [{"name": "id", "type": "int"}, {"name": "name", "type": "varchar"}]}}, "version": "1"}
        request = JsonRpcRequest(
            method="sqlguard.schema_diff",
            params={"schema1_context": s1, "schema2_context": s2},
            id=221,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardRewriteDispatch:
    def test_basic_rewrite(self):
        request = JsonRpcRequest(
            method="sqlguard.rewrite",
            params={"sql": "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)"},
            id=230,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardCorrectDispatch:
    def test_basic_correct(self):
        request = JsonRpcRequest(
            method="sqlguard.correct",
            params={"sql": "SELCT * FORM orders"},
            id=240,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardGradeDispatch:
    def test_basic_grade(self):
        request = JsonRpcRequest(
            method="sqlguard.grade",
            params={"sql": "SELECT id FROM users WHERE id = 1"},
            id=250,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result



# ---------------------------------------------------------------------------
# Phase 3 (P2): Complete coverage
# ---------------------------------------------------------------------------


class TestSqlGuardClassifyPiiDispatch:
    def test_with_schema_context(self):
        schema = {
            "tables": {
                "users": {
                    "columns": [
                        {"name": "email", "type": "varchar"},
                        {"name": "ssn", "type": "varchar"},
                    ]
                }
            },
            "version": "1",
        }
        request = JsonRpcRequest(
            method="sqlguard.classify_pii",
            params={"schema_context": schema},
            id=300,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardQueryPiiDispatch:
    def test_basic_pii(self):
        request = JsonRpcRequest(
            method="sqlguard.query_pii",
            params={"sql": "SELECT email, ssn FROM users"},
            id=310,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardResolveTermDispatch:
    def test_basic_resolve(self):
        request = JsonRpcRequest(
            method="sqlguard.resolve_term",
            params={"term": "customer"},
            id=320,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardColumnLineageDispatch:
    def test_basic_lineage(self):
        request = JsonRpcRequest(
            method="sqlguard.column_lineage",
            params={"sql": "SELECT id FROM users"},
            id=330,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardTrackLineageDispatch:
    def test_basic_tracking(self):
        request = JsonRpcRequest(
            method="sqlguard.track_lineage",
            params={"queries": ["SELECT id FROM users", "SELECT user_id FROM orders"]},
            id=340,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardFormatDispatch:
    def test_basic_format(self):
        request = JsonRpcRequest(
            method="sqlguard.format",
            params={"sql": "select id,name from users where id=1"},
            id=350,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result

    def test_with_dialect(self):
        request = JsonRpcRequest(
            method="sqlguard.format",
            params={"sql": "SELECT 1", "dialect": "postgres"},
            id=351,
        )
        response = dispatch(request)
        assert response.error is None


class TestSqlGuardMetadataDispatch:
    def test_basic_metadata(self):
        request = JsonRpcRequest(
            method="sqlguard.metadata",
            params={"sql": "SELECT id, name FROM users WHERE active = true"},
            id=360,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardCompareDispatch:
    def test_basic_compare(self):
        request = JsonRpcRequest(
            method="sqlguard.compare",
            params={"left_sql": "SELECT 1", "right_sql": "SELECT 2"},
            id=370,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardCompleteDispatch:
    def test_basic_complete(self):
        request = JsonRpcRequest(
            method="sqlguard.complete",
            params={"sql": "SELECT ", "cursor_pos": 7},
            id=380,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardOptimizeContextDispatch:
    def test_with_schema_context(self):
        request = JsonRpcRequest(
            method="sqlguard.optimize_context",
            params={"schema_context": SCHEMA_CTX},
            id=390,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardOptimizeForQueryDispatch:
    def test_basic_optimize(self):
        request = JsonRpcRequest(
            method="sqlguard.optimize_for_query",
            params={"sql": "SELECT id FROM users"},
            id=400,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardPruneSchemaDispatch:
    def test_basic_prune(self):
        request = JsonRpcRequest(
            method="sqlguard.prune_schema",
            params={"sql": "SELECT id FROM users"},
            id=410,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardImportDdlDispatch:
    def test_basic_import(self):
        request = JsonRpcRequest(
            method="sqlguard.import_ddl",
            params={"ddl": "CREATE TABLE users (id INT, name VARCHAR(255))"},
            id=420,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardExportDdlDispatch:
    def test_with_schema_context(self):
        request = JsonRpcRequest(
            method="sqlguard.export_ddl",
            params={"schema_context": SCHEMA_CTX},
            id=430,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardFingerprintDispatch:
    def test_with_schema_context(self):
        request = JsonRpcRequest(
            method="sqlguard.fingerprint",
            params={"schema_context": SCHEMA_CTX},
            id=440,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardIntrospectionSqlDispatch:
    def test_basic_introspection(self):
        request = JsonRpcRequest(
            method="sqlguard.introspection_sql",
            params={"db_type": "postgres", "database": "mydb"},
            id=450,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result

    def test_with_schema_name(self):
        request = JsonRpcRequest(
            method="sqlguard.introspection_sql",
            params={"db_type": "snowflake", "database": "mydb", "schema_name": "public"},
            id=451,
        )
        response = dispatch(request)
        assert response.error is None


class TestSqlGuardParseDbtDispatch:
    def test_basic_parse(self):
        request = JsonRpcRequest(
            method="sqlguard.parse_dbt",
            params={"project_dir": "/nonexistent/dbt/project"},
            id=460,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardIsSafeDispatch:
    def test_safe_query(self):
        request = JsonRpcRequest(
            method="sqlguard.is_safe",
            params={"sql": "SELECT 1"},
            id=470,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result

    def test_unsafe_query(self):
        request = JsonRpcRequest(
            method="sqlguard.is_safe",
            params={"sql": "DROP TABLE users"},
            id=471,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


# ---------------------------------------------------------------------------
# Invalid Params Tests
# ---------------------------------------------------------------------------


class TestSqlGuardNewInvalidParams:
    def test_fix_no_sql(self):
        request = JsonRpcRequest(
            method="sqlguard.fix",
            params={},
            id=500,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_policy_no_sql(self):
        request = JsonRpcRequest(
            method="sqlguard.policy",
            params={},
            id=501,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_policy_no_policy_json(self):
        request = JsonRpcRequest(
            method="sqlguard.policy",
            params={"sql": "SELECT 1"},
            id=502,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_semantics_no_sql(self):
        request = JsonRpcRequest(
            method="sqlguard.semantics",
            params={},
            id=504,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_testgen_no_sql(self):
        request = JsonRpcRequest(
            method="sqlguard.testgen",
            params={},
            id=505,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_equivalence_no_params(self):
        request = JsonRpcRequest(
            method="sqlguard.equivalence",
            params={},
            id=506,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_correct_no_sql(self):
        request = JsonRpcRequest(
            method="sqlguard.correct",
            params={},
            id=508,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_complete_no_params(self):
        request = JsonRpcRequest(
            method="sqlguard.complete",
            params={},
            id=509,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_introspection_sql_no_params(self):
        request = JsonRpcRequest(
            method="sqlguard.introspection_sql",
            params={},
            id=510,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_import_ddl_no_params(self):
        request = JsonRpcRequest(
            method="sqlguard.import_ddl",
            params={},
            id=511,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_compare_no_params(self):
        request = JsonRpcRequest(
            method="sqlguard.compare",
            params={},
            id=512,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_track_lineage_no_params(self):
        request = JsonRpcRequest(
            method="sqlguard.track_lineage",
            params={},
            id=513,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_is_safe_no_sql(self):
        request = JsonRpcRequest(
            method="sqlguard.is_safe",
            params={},
            id=514,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_parse_dbt_no_params(self):
        request = JsonRpcRequest(
            method="sqlguard.parse_dbt",
            params={},
            id=515,
        )
        response = dispatch(request)
        assert response.error is not None
