"""Tests for sqlguard JSON-RPC server dispatch."""

import pytest

from altimate_engine.models import JsonRpcRequest
from altimate_engine.server import dispatch
from altimate_engine.sql.guard import SQLGUARD_AVAILABLE


# Skip all tests if sqlguard is not installed
pytestmark = pytest.mark.skipif(
    not SQLGUARD_AVAILABLE, reason="sqlguard not installed"
)


class TestSqlGuardValidateDispatch:
    def test_basic_validate(self):
        request = JsonRpcRequest(
            method="sqlguard.validate",
            params={"sql": "SELECT 1"},
            id=1,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result
        assert "success" in response.result

    def test_validate_with_schema_path(self):
        request = JsonRpcRequest(
            method="sqlguard.validate",
            params={"sql": "SELECT 1", "schema_path": ""},
            id=2,
        )
        response = dispatch(request)
        assert response.error is None

    def test_validate_with_schema_context(self):
        request = JsonRpcRequest(
            method="sqlguard.validate",
            params={
                "sql": "SELECT id FROM users",
                "schema_context": {
                    "tables": {"users": {"columns": [{"name": "id", "type": "int"}]}},
                    "version": "1",
                },
            },
            id=3,
        )
        response = dispatch(request)
        assert response.error is None


class TestSqlGuardLintDispatch:
    def test_basic_lint(self):
        request = JsonRpcRequest(
            method="sqlguard.lint",
            params={"sql": "SELECT * FROM users WHERE name = NULL"},
            id=10,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result

    def test_clean_sql_lint(self):
        request = JsonRpcRequest(
            method="sqlguard.lint",
            params={"sql": "SELECT id FROM users WHERE id = 1"},
            id=11,
        )
        response = dispatch(request)
        assert response.error is None


class TestSqlGuardSafetyDispatch:
    def test_safe_query(self):
        request = JsonRpcRequest(
            method="sqlguard.safety",
            params={"sql": "SELECT 1"},
            id=20,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["data"].get("safe") is True

    def test_unsafe_query(self):
        request = JsonRpcRequest(
            method="sqlguard.safety",
            params={"sql": "DROP TABLE users"},
            id=21,
        )
        response = dispatch(request)
        assert response.error is None
        data = response.result["data"]
        assert data.get("safe") is False or data.get("threats")


class TestSqlGuardTranspileDispatch:
    def test_basic_transpile(self):
        request = JsonRpcRequest(
            method="sqlguard.transpile",
            params={"sql": "SELECT 1", "from_dialect": "generic", "to_dialect": "postgres"},
            id=30,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result

    def test_missing_params(self):
        request = JsonRpcRequest(
            method="sqlguard.transpile",
            params={"sql": "SELECT 1"},
            id=31,
        )
        response = dispatch(request)
        # Should error due to missing required params
        assert response.error is not None


class TestSqlGuardExplainDispatch:
    def test_basic_explain(self):
        request = JsonRpcRequest(
            method="sqlguard.explain",
            params={"sql": "SELECT 1"},
            id=40,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result


class TestSqlGuardCheckDispatch:
    def test_basic_check(self):
        request = JsonRpcRequest(
            method="sqlguard.check",
            params={"sql": "SELECT 1"},
            id=50,
        )
        response = dispatch(request)
        assert response.error is None
        assert "data" in response.result

    def test_check_unsafe_sql(self):
        request = JsonRpcRequest(
            method="sqlguard.check",
            params={"sql": "DROP TABLE users; SELECT * FROM passwords"},
            id=51,
        )
        response = dispatch(request)
        assert response.error is None


class TestSqlGuardInvalidParams:
    def test_validate_no_sql(self):
        request = JsonRpcRequest(
            method="sqlguard.validate",
            params={},
            id=60,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_lint_no_sql(self):
        request = JsonRpcRequest(
            method="sqlguard.lint",
            params={},
            id=61,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_safety_no_sql(self):
        request = JsonRpcRequest(
            method="sqlguard.safety",
            params={},
            id=62,
        )
        response = dispatch(request)
        assert response.error is not None
