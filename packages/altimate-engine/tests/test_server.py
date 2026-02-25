"""Tests for the JSON-RPC server dispatch."""

import json
import pytest
from altimate_engine.server import dispatch, handle_line
from altimate_engine.models import JsonRpcRequest


class TestDispatch:
    def test_ping(self):
        request = JsonRpcRequest(method="ping", id=1)
        response = dispatch(request)
        assert response.result == {"status": "ok"}
        assert response.error is None

    def test_sql_validate(self):
        request = JsonRpcRequest(
            method="sql.validate",
            params={"sql": "SELECT 1"},
            id=2,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["valid"] is True

    def test_sql_check(self):
        request = JsonRpcRequest(
            method="sql.check",
            params={"sql": "SELECT 1"},
            id=3,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["safe"] is True

    def test_sql_analyze(self):
        request = JsonRpcRequest(
            method="sql.analyze",
            params={"sql": "SELECT * FROM orders", "dialect": "snowflake"},
            id=4,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is True
        assert "issues" in response.result

    def test_lineage_check(self):
        request = JsonRpcRequest(
            method="lineage.check",
            params={"sql": "SELECT a.id FROM users a", "dialect": "snowflake"},
            id=5,
        )
        response = dispatch(request)
        assert response.error is None
        assert "edges" in response.result
        assert "confidence" in response.result
        assert "confidence_factors" in response.result

    def test_method_not_found(self):
        request = JsonRpcRequest(method="nonexistent.method", id=6)
        response = dispatch(request)
        assert response.error is not None
        assert response.error.code == -32601

    def test_invalid_params(self):
        request = JsonRpcRequest(
            method="sql.validate",
            params={"wrong_param": "value"},
            id=7,
        )
        response = dispatch(request)
        assert response.error is not None

    def test_sql_record_feedback(self):
        request = JsonRpcRequest(
            method="sql.record_feedback",
            params={
                "sql": "SELECT 1",
                "dialect": "snowflake",
                "bytes_scanned": 1000,
                "execution_time_ms": 100,
            },
            id=8,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["recorded"] is True

    def test_sql_predict_cost(self):
        request = JsonRpcRequest(
            method="sql.predict_cost",
            params={"sql": "SELECT 1", "dialect": "snowflake"},
            id=9,
        )
        response = dispatch(request)
        assert response.error is None
        assert "tier" in response.result
        assert "confidence" in response.result

    def test_warehouse_list(self):
        request = JsonRpcRequest(method="warehouse.list", params={}, id=10)
        response = dispatch(request)
        assert response.error is None
        assert "warehouses" in response.result

    def test_sql_format(self):
        request = JsonRpcRequest(
            method="sql.format",
            params={"sql": "select a,b from t", "dialect": "snowflake"},
            id=11,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is True
        assert response.result["statement_count"] == 1

    def test_sql_fix(self):
        request = JsonRpcRequest(
            method="sql.fix",
            params={
                "sql": "SELECT * FROM t",
                "error_message": "Object 't' does not exist",
                "dialect": "snowflake",
            },
            id=12,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is True
        assert response.result["suggestion_count"] >= 1

    def test_sql_explain_no_warehouse(self):
        request = JsonRpcRequest(
            method="sql.explain",
            params={"sql": "SELECT 1"},
            id=13,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "No warehouse" in response.result["error"]

    def test_sql_autocomplete(self):
        request = JsonRpcRequest(
            method="sql.autocomplete",
            params={"prefix": "cust", "position": "any"},
            id=14,
        )
        response = dispatch(request)
        assert response.error is None
        assert "suggestions" in response.result
        assert "suggestion_count" in response.result


class TestHandleLine:
    def test_valid_request(self):
        line = json.dumps({"jsonrpc": "2.0", "method": "ping", "id": 1})
        result = handle_line(line)
        assert result is not None
        parsed = json.loads(result)
        assert parsed["result"]["status"] == "ok"

    def test_empty_line(self):
        result = handle_line("")
        assert result is None

    def test_invalid_json(self):
        result = handle_line("not json at all")
        assert result is not None
        parsed = json.loads(result)
        assert parsed["error"]["code"] == -32700

    def test_whitespace_line(self):
        result = handle_line("   \n")
        assert result is None
