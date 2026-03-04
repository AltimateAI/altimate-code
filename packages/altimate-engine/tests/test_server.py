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
        assert "success" in response.result
        assert "data" in response.result

    def test_method_not_found(self):
        request = JsonRpcRequest(method="nonexistent.method", id=6)
        response = dispatch(request)
        assert response.error is not None
        assert response.error.code == -32601

    def test_invalid_params(self):
        request = JsonRpcRequest(
            method="sql.analyze",
            params={"wrong_param": "value"},
            id=7,
        )
        response = dispatch(request)
        assert response.error is not None

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
        # Fix may or may not succeed depending on whether the issue is auto-fixable
        assert "success" in response.result
        assert "original_sql" in response.result

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


class TestDispatchSqlDiff:
    """Dispatch tests for sql.diff — pure computation, no external deps."""

    def test_sql_diff_identical(self):
        request = JsonRpcRequest(
            method="sql.diff",
            params={"original": "SELECT 1", "modified": "SELECT 1"},
            id=100,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["has_changes"] is False
        assert response.result["similarity"] == 1.0
        assert response.result["additions"] == 0
        assert response.result["deletions"] == 0

    def test_sql_diff_with_changes(self):
        request = JsonRpcRequest(
            method="sql.diff",
            params={"original": "SELECT id FROM users", "modified": "SELECT id FROM customers"},
            id=101,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["has_changes"] is True
        assert response.result["change_count"] >= 1
        assert response.result["similarity"] < 1.0

    def test_sql_diff_custom_context(self):
        request = JsonRpcRequest(
            method="sql.diff",
            params={
                "original": "SELECT 1\nSELECT 2\nSELECT 3",
                "modified": "SELECT 1\nSELECT 99\nSELECT 3",
                "context_lines": 0,
            },
            id=102,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["has_changes"] is True


class TestDispatchSchemaPii:
    """Dispatch tests for schema.detect_pii — uses SchemaCache singleton."""

    def test_schema_detect_pii_dispatches(self):
        request = JsonRpcRequest(
            method="schema.detect_pii",
            params={},
            id=110,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is True
        assert "finding_count" in response.result
        assert "columns_scanned" in response.result
        assert "by_category" in response.result
        assert "tables_with_pii" in response.result
        assert isinstance(response.result["findings"], list)


class TestDispatchFinops:
    """Dispatch tests for finops methods.

    These methods call ConnectionRegistry internally. With no connections
    configured, they return success=False with a 'not found' error. This
    verifies the dispatch routes correctly and the Pydantic response model
    is valid.
    """

    def test_finops_query_history(self):
        request = JsonRpcRequest(
            method="finops.query_history",
            params={"warehouse": "nonexistent"},
            id=200,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "not found" in response.result["error"]

    def test_finops_analyze_credits(self):
        request = JsonRpcRequest(
            method="finops.analyze_credits",
            params={"warehouse": "nonexistent"},
            id=201,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "not found" in response.result["error"]

    def test_finops_expensive_queries(self):
        request = JsonRpcRequest(
            method="finops.expensive_queries",
            params={"warehouse": "nonexistent"},
            id=202,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "not found" in response.result["error"]

    def test_finops_warehouse_advice(self):
        request = JsonRpcRequest(
            method="finops.warehouse_advice",
            params={"warehouse": "nonexistent"},
            id=203,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "not found" in response.result["error"]

    def test_finops_unused_resources(self):
        request = JsonRpcRequest(
            method="finops.unused_resources",
            params={"warehouse": "nonexistent"},
            id=204,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "not found" in response.result["error"]

    def test_finops_role_grants(self):
        request = JsonRpcRequest(
            method="finops.role_grants",
            params={"warehouse": "nonexistent"},
            id=205,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "not found" in response.result["error"]

    def test_finops_role_hierarchy(self):
        request = JsonRpcRequest(
            method="finops.role_hierarchy",
            params={"warehouse": "nonexistent"},
            id=206,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "not found" in response.result["error"]

    def test_finops_user_roles(self):
        request = JsonRpcRequest(
            method="finops.user_roles",
            params={"warehouse": "nonexistent"},
            id=207,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "not found" in response.result["error"]


class TestDispatchSchemaTags:
    """Dispatch tests for schema.tags and schema.tags_list."""

    def test_schema_tags(self):
        request = JsonRpcRequest(
            method="schema.tags",
            params={"warehouse": "nonexistent"},
            id=210,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "not found" in response.result["error"]

    def test_schema_tags_list(self):
        request = JsonRpcRequest(
            method="schema.tags_list",
            params={"warehouse": "nonexistent"},
            id=211,
        )
        response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "not found" in response.result["error"]


class TestDispatchWarehouseAdd:
    """Dispatch tests for warehouse.add."""

    def test_warehouse_add_success(self):
        request = JsonRpcRequest(
            method="warehouse.add",
            params={"name": "test_db", "config": {"type": "duckdb", "path": ":memory:"}},
            id=300,
        )
        from unittest.mock import patch
        with patch("altimate_engine.connections.ConnectionRegistry.add", return_value={"type": "duckdb"}):
            response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is True
        assert response.result["name"] == "test_db"
        assert response.result["type"] == "duckdb"

    def test_warehouse_add_failure(self):
        request = JsonRpcRequest(
            method="warehouse.add",
            params={"name": "bad_db", "config": {"type": "invalid"}},
            id=301,
        )
        from unittest.mock import patch
        with patch("altimate_engine.connections.ConnectionRegistry.add", side_effect=Exception("Write failed")):
            response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False
        assert "Write failed" in response.result["error"]


class TestDispatchWarehouseRemove:
    """Dispatch tests for warehouse.remove."""

    def test_warehouse_remove_success(self):
        request = JsonRpcRequest(
            method="warehouse.remove",
            params={"name": "old_db"},
            id=310,
        )
        from unittest.mock import patch
        with patch("altimate_engine.connections.ConnectionRegistry.remove", return_value=True):
            response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is True

    def test_warehouse_remove_not_found(self):
        request = JsonRpcRequest(
            method="warehouse.remove",
            params={"name": "nonexistent"},
            id=311,
        )
        from unittest.mock import patch
        with patch("altimate_engine.connections.ConnectionRegistry.remove", return_value=False):
            response = dispatch(request)
        assert response.error is None
        assert response.result["success"] is False


class TestDispatchWarehouseDiscover:
    """Dispatch tests for warehouse.discover."""

    def test_warehouse_discover_empty(self):
        request = JsonRpcRequest(
            method="warehouse.discover",
            params={},
            id=320,
        )
        from unittest.mock import patch
        with patch("altimate_engine.docker_discovery.discover_containers", return_value=[]):
            response = dispatch(request)
        assert response.error is None
        assert response.result["container_count"] == 0
        assert response.result["containers"] == []

    def test_warehouse_discover_with_results(self):
        request = JsonRpcRequest(
            method="warehouse.discover",
            params={},
            id=321,
        )
        containers = [
            {
                "container_id": "abc123",
                "name": "my_pg",
                "image": "postgres:16",
                "db_type": "postgres",
                "host": "localhost",
                "port": 5432,
                "user": "admin",
                "password": "secret",
                "database": "mydb",
                "status": "running",
            }
        ]
        from unittest.mock import patch
        with patch("altimate_engine.docker_discovery.discover_containers", return_value=containers):
            response = dispatch(request)
        assert response.error is None
        assert response.result["container_count"] == 1
        assert len(response.result["containers"]) == 1
        assert response.result["containers"][0]["db_type"] == "postgres"


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
