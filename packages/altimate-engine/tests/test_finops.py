"""Tests for finops modules — query history, credit analysis, warehouse advisor, unused resources, role access."""

from unittest.mock import patch, MagicMock

import pytest

from altimate_engine.finops.query_history import get_query_history, _build_history_query
from altimate_engine.finops.credit_analyzer import (
    analyze_credits,
    get_expensive_queries,
    _generate_recommendations,
)
from altimate_engine.finops.warehouse_advisor import (
    advise_warehouse_sizing,
    _generate_sizing_recommendations,
)
from altimate_engine.finops.unused_resources import find_unused_resources
from altimate_engine.finops.role_access import (
    query_grants,
    query_role_hierarchy,
    query_user_roles,
)


# --- Shared fixtures ---


def _mock_snowflake_registry(warehouse_name="my-sf"):
    """Patch ConnectionRegistry to return a mock Snowflake connector."""
    mock_connector = MagicMock()
    mock_connector.execute.return_value = []

    def mock_get(name):
        if name == warehouse_name:
            return mock_connector
        raise ValueError(f"Connection '{name}' not found in registry")

    def mock_list():
        return [{"name": warehouse_name, "type": "snowflake"}]

    return mock_connector, mock_get, mock_list


def _mock_duckdb_registry(warehouse_name="my-duck"):
    """Patch ConnectionRegistry to return a mock DuckDB connector."""
    mock_connector = MagicMock()
    mock_connector.execute.return_value = []

    def mock_get(name):
        if name == warehouse_name:
            return mock_connector
        raise ValueError(f"Connection '{name}' not found in registry")

    def mock_list():
        return [{"name": warehouse_name, "type": "duckdb"}]

    return mock_connector, mock_get, mock_list


# =====================
# Query History Tests
# =====================


class TestBuildHistoryQuery:
    def test_snowflake_query(self):
        sql = _build_history_query("snowflake", 7, 100, None, None)
        assert sql is not None
        assert "QUERY_HISTORY" in sql
        assert "7" in sql
        assert "100" in sql

    def test_snowflake_with_user_filter(self):
        sql = _build_history_query("snowflake", 7, 100, "admin", None)
        assert "admin" in sql

    def test_snowflake_with_warehouse_filter(self):
        sql = _build_history_query("snowflake", 7, 100, None, "COMPUTE_WH")
        assert "COMPUTE_WH" in sql

    def test_postgres_query(self):
        sql = _build_history_query("postgres", 7, 100, None, None)
        assert sql is not None
        assert "pg_stat_statements" in sql

    def test_duckdb_returns_none(self):
        sql = _build_history_query("duckdb", 7, 100, None, None)
        assert sql is None

    def test_unknown_type_returns_none(self):
        sql = _build_history_query("unknown", 7, 100, None, None)
        assert sql is None


class TestGetQueryHistory:
    @patch("altimate_engine.finops.query_history.ConnectionRegistry")
    def test_connection_not_found(self, mock_registry):
        mock_registry.get.side_effect = ValueError("Connection 'bad' not found")
        result = get_query_history("bad")
        assert result["success"] is False
        assert "not found" in result["error"]
        assert result["queries"] == []

    @patch("altimate_engine.finops.query_history.ConnectionRegistry")
    def test_duckdb_not_supported(self, mock_registry):
        connector, mock_get, mock_list = _mock_duckdb_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()

        result = get_query_history("my-duck")
        assert result["success"] is False
        assert "not available" in result["error"]

    @patch("altimate_engine.finops.query_history.ConnectionRegistry")
    def test_snowflake_success_empty(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()

        result = get_query_history("my-sf")
        assert result["success"] is True
        assert result["queries"] == []
        assert result["warehouse_type"] == "snowflake"
        assert result["summary"]["query_count"] == 0

    @patch("altimate_engine.finops.query_history.ConnectionRegistry")
    def test_snowflake_success_with_rows(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = [
            {
                "query_id": "q1",
                "query_text": "SELECT 1",
                "execution_status": "SUCCESS",
                "bytes_scanned": 1000,
                "execution_time_sec": 1.5,
            },
            {
                "query_id": "q2",
                "query_text": "SELECT 2",
                "execution_status": "FAIL",
                "bytes_scanned": 500,
                "execution_time_sec": 0.5,
            },
        ]

        result = get_query_history("my-sf")
        assert result["success"] is True
        assert len(result["queries"]) == 2
        assert result["summary"]["query_count"] == 2
        assert result["summary"]["total_bytes_scanned"] == 1500
        assert result["summary"]["error_count"] == 1
        assert result["summary"]["avg_execution_time_sec"] == 1.0

    @patch("altimate_engine.finops.query_history.ConnectionRegistry")
    def test_connector_error_handled(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.side_effect = RuntimeError("connection lost")

        result = get_query_history("my-sf")
        assert result["success"] is False
        assert "connection lost" in result["error"]


# =====================
# Credit Analyzer Tests
# =====================


class TestGenerateRecommendations:
    def test_idle_warehouse(self):
        summary = [{
            "warehouse_name": "DEV_WH",
            "total_credits": 50,
            "active_days": 3,
        }]
        recs = _generate_recommendations(summary, [], 30)
        types = [r["type"] for r in recs]
        assert "IDLE_WAREHOUSE" in types

    def test_high_usage(self):
        summary = [{
            "warehouse_name": "PROD_WH",
            "total_credits": 200,
            "active_days": 25,
        }]
        recs = _generate_recommendations(summary, [], 30)
        types = [r["type"] for r in recs]
        assert "HIGH_USAGE" in types

    def test_healthy_when_no_issues(self):
        summary = [{
            "warehouse_name": "SMALL_WH",
            "total_credits": 5,
            "active_days": 20,
        }]
        recs = _generate_recommendations(summary, [], 30)
        types = [r["type"] for r in recs]
        assert "HEALTHY" in types


class TestAnalyzeCredits:
    @patch("altimate_engine.finops.credit_analyzer.ConnectionRegistry")
    def test_connection_not_found(self, mock_registry):
        mock_registry.get.side_effect = ValueError("Connection 'bad' not found")
        result = analyze_credits("bad")
        assert result["success"] is False
        assert "not found" in result["error"]

    @patch("altimate_engine.finops.credit_analyzer.ConnectionRegistry")
    def test_non_snowflake_rejected(self, mock_registry):
        connector, mock_get, mock_list = _mock_duckdb_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        result = analyze_credits("my-duck")
        assert result["success"] is False
        assert "not available" in result["error"]

    @patch("altimate_engine.finops.credit_analyzer.ConnectionRegistry")
    def test_snowflake_success_empty(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        # First call = daily, second = summary
        connector.execute.side_effect = [[], []]

        result = analyze_credits("my-sf")
        assert result["success"] is True
        assert result["daily_usage"] == []
        assert result["total_credits"] == 0
        assert result["days_analyzed"] == 30
        assert len(result["recommendations"]) > 0

    @patch("altimate_engine.finops.credit_analyzer.ConnectionRegistry")
    def test_snowflake_with_data(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.side_effect = [
            # daily usage
            [{"warehouse_name": "WH", "usage_date": "2025-01-01", "credits_used": 10}],
            # warehouse summary
            [{"warehouse_name": "WH", "total_credits": 50, "active_days": 15}],
        ]

        result = analyze_credits("my-sf")
        assert result["success"] is True
        assert result["total_credits"] == 50
        assert len(result["daily_usage"]) == 1


class TestGetExpensiveQueries:
    @patch("altimate_engine.finops.credit_analyzer.ConnectionRegistry")
    def test_connection_not_found(self, mock_registry):
        mock_registry.get.side_effect = ValueError("Connection 'bad' not found")
        result = get_expensive_queries("bad")
        assert result["success"] is False

    @patch("altimate_engine.finops.credit_analyzer.ConnectionRegistry")
    def test_non_snowflake_rejected(self, mock_registry):
        connector, mock_get, mock_list = _mock_duckdb_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        result = get_expensive_queries("my-duck")
        assert result["success"] is False
        assert "not available" in result["error"]

    @patch("altimate_engine.finops.credit_analyzer.ConnectionRegistry")
    def test_snowflake_success(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = [
            {"query_id": "q1", "bytes_scanned": 999999},
        ]

        result = get_expensive_queries("my-sf")
        assert result["success"] is True
        assert result["query_count"] == 1
        assert result["days_analyzed"] == 7


# ========================
# Warehouse Advisor Tests
# ========================


class TestGenerateSizingRecommendations:
    def test_scale_up_on_high_queue(self):
        load_data = [{
            "warehouse_name": "BIG_WH",
            "warehouse_size": "Medium",
            "avg_queue_load": 2.0,
            "peak_queue_load": 5.0,
            "avg_concurrency": 3.0,
        }]
        recs = _generate_sizing_recommendations(load_data, [])
        types = [r["type"] for r in recs]
        assert "SCALE_UP" in types

    def test_burst_scaling_on_peak_queue(self):
        load_data = [{
            "warehouse_name": "BURST_WH",
            "warehouse_size": "Small",
            "avg_queue_load": 0.5,
            "peak_queue_load": 8.0,
            "avg_concurrency": 1.0,
        }]
        recs = _generate_sizing_recommendations(load_data, [])
        types = [r["type"] for r in recs]
        assert "BURST_SCALING" in types

    def test_scale_down_on_low_utilization(self):
        load_data = [{
            "warehouse_name": "IDLE_WH",
            "warehouse_size": "Large",
            "avg_queue_load": 0.001,
            "peak_queue_load": 0.01,
            "avg_concurrency": 0.05,
        }]
        recs = _generate_sizing_recommendations(load_data, [])
        types = [r["type"] for r in recs]
        assert "SCALE_DOWN" in types
        # Should suggest Medium
        scale_down = [r for r in recs if r["type"] == "SCALE_DOWN"][0]
        assert scale_down["suggested_size"] == "Medium"

    def test_healthy_when_normal(self):
        load_data = [{
            "warehouse_name": "NORMAL_WH",
            "warehouse_size": "Medium",
            "avg_queue_load": 0.3,
            "peak_queue_load": 1.0,
            "avg_concurrency": 1.5,
        }]
        recs = _generate_sizing_recommendations(load_data, [])
        types = [r["type"] for r in recs]
        assert "HEALTHY" in types

    def test_empty_data_healthy(self):
        recs = _generate_sizing_recommendations([], [])
        types = [r["type"] for r in recs]
        assert "HEALTHY" in types


class TestAdviseWarehouseSizing:
    @patch("altimate_engine.finops.warehouse_advisor.ConnectionRegistry")
    def test_connection_not_found(self, mock_registry):
        mock_registry.get.side_effect = ValueError("Connection 'bad' not found")
        result = advise_warehouse_sizing("bad")
        assert result["success"] is False

    @patch("altimate_engine.finops.warehouse_advisor.ConnectionRegistry")
    def test_non_snowflake_rejected(self, mock_registry):
        connector, mock_get, mock_list = _mock_duckdb_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        result = advise_warehouse_sizing("my-duck")
        assert result["success"] is False
        assert "not available" in result["error"]

    @patch("altimate_engine.finops.warehouse_advisor.ConnectionRegistry")
    def test_snowflake_success(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.side_effect = [
            # load data
            [{"warehouse_name": "WH", "warehouse_size": "Medium",
              "avg_concurrency": 1.0, "avg_queue_load": 0.5, "peak_queue_load": 1.0}],
            # sizing data
            [{"warehouse_name": "WH", "warehouse_size": "Medium",
              "query_count": 100, "avg_time_sec": 2.0}],
        ]

        result = advise_warehouse_sizing("my-sf")
        assert result["success"] is True
        assert result["days_analyzed"] == 14
        assert len(result["warehouse_load"]) == 1
        assert len(result["recommendations"]) > 0


# ==========================
# Unused Resources Tests
# ==========================


class TestFindUnusedResources:
    @patch("altimate_engine.finops.unused_resources.ConnectionRegistry")
    def test_connection_not_found(self, mock_registry):
        mock_registry.get.side_effect = ValueError("Connection 'bad' not found")
        result = find_unused_resources("bad")
        assert result["success"] is False

    @patch("altimate_engine.finops.unused_resources.ConnectionRegistry")
    def test_non_snowflake_rejected(self, mock_registry):
        connector, mock_get, mock_list = _mock_duckdb_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        result = find_unused_resources("my-duck")
        assert result["success"] is False
        assert "not available" in result["error"]

    @patch("altimate_engine.finops.unused_resources.ConnectionRegistry")
    def test_snowflake_success_empty(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        # Two calls: unused tables + idle warehouses
        connector.execute.side_effect = [[], []]

        result = find_unused_resources("my-sf")
        assert result["success"] is True
        assert result["unused_tables"] == []
        assert result["idle_warehouses"] == []
        assert result["summary"]["unused_table_count"] == 0
        assert result["summary"]["idle_warehouse_count"] == 0
        assert result["summary"]["total_stale_storage_gb"] == 0

    @patch("altimate_engine.finops.unused_resources.ConnectionRegistry")
    def test_snowflake_with_unused_tables(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.side_effect = [
            # unused tables (first attempt)
            [{"table_name": "old_backup", "size_bytes": 1073741824}],
            # idle warehouses
            [{"warehouse_name": "DEV_WH", "is_idle": True}],
        ]

        result = find_unused_resources("my-sf")
        assert result["success"] is True
        assert result["summary"]["unused_table_count"] == 1
        assert result["summary"]["idle_warehouse_count"] == 1
        assert result["summary"]["total_stale_storage_gb"] == 1.0

    @patch("altimate_engine.finops.unused_resources.ConnectionRegistry")
    def test_fallback_on_access_history_error(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        # First call (ACCESS_HISTORY) fails, second (simple) succeeds, third (warehouses) succeeds
        connector.execute.side_effect = [
            RuntimeError("ACCESS_HISTORY not available"),
            [{"table_name": "stale_table", "size_bytes": 0}],
            [],
        ]

        result = find_unused_resources("my-sf")
        assert result["success"] is True
        assert result["summary"]["unused_table_count"] == 1


# ==========================
# Role Access Tests
# ==========================


class TestQueryGrants:
    @patch("altimate_engine.finops.role_access.ConnectionRegistry")
    def test_connection_not_found(self, mock_registry):
        mock_registry.get.side_effect = ValueError("Connection 'bad' not found")
        result = query_grants("bad")
        assert result["success"] is False

    @patch("altimate_engine.finops.role_access.ConnectionRegistry")
    def test_non_snowflake_rejected(self, mock_registry):
        connector, mock_get, mock_list = _mock_duckdb_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        result = query_grants("my-duck")
        assert result["success"] is False
        assert "not available" in result["error"]

    @patch("altimate_engine.finops.role_access.ConnectionRegistry")
    def test_snowflake_success_empty(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = []

        result = query_grants("my-sf")
        assert result["success"] is True
        assert result["grants"] == []
        assert result["grant_count"] == 0
        assert result["privilege_summary"] == {}

    @patch("altimate_engine.finops.role_access.ConnectionRegistry")
    def test_snowflake_with_grants(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = [
            {"privilege": "SELECT", "object_type": "TABLE", "object_name": "ORDERS", "granted_to": "ANALYST"},
            {"privilege": "SELECT", "object_type": "TABLE", "object_name": "USERS", "granted_to": "ANALYST"},
            {"privilege": "INSERT", "object_type": "TABLE", "object_name": "ORDERS", "granted_to": "WRITER"},
        ]

        result = query_grants("my-sf")
        assert result["success"] is True
        assert result["grant_count"] == 3
        assert result["privilege_summary"]["SELECT"] == 2
        assert result["privilege_summary"]["INSERT"] == 1


class TestQueryRoleHierarchy:
    @patch("altimate_engine.finops.role_access.ConnectionRegistry")
    def test_connection_not_found(self, mock_registry):
        mock_registry.get.side_effect = ValueError("Connection 'bad' not found")
        result = query_role_hierarchy("bad")
        assert result["success"] is False

    @patch("altimate_engine.finops.role_access.ConnectionRegistry")
    def test_non_snowflake_rejected(self, mock_registry):
        connector, mock_get, mock_list = _mock_duckdb_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        result = query_role_hierarchy("my-duck")
        assert result["success"] is False

    @patch("altimate_engine.finops.role_access.ConnectionRegistry")
    def test_snowflake_success(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = [
            {"child_role": "ANALYST", "parent_role": "SYSADMIN"},
            {"child_role": "WRITER", "parent_role": "SYSADMIN"},
        ]

        result = query_role_hierarchy("my-sf")
        assert result["success"] is True
        assert len(result["hierarchy"]) == 2
        # role_count should count unique roles across both child and parent
        assert result["role_count"] == 3  # ANALYST, WRITER, SYSADMIN


class TestQueryUserRoles:
    @patch("altimate_engine.finops.role_access.ConnectionRegistry")
    def test_connection_not_found(self, mock_registry):
        mock_registry.get.side_effect = ValueError("Connection 'bad' not found")
        result = query_user_roles("bad")
        assert result["success"] is False

    @patch("altimate_engine.finops.role_access.ConnectionRegistry")
    def test_non_snowflake_rejected(self, mock_registry):
        connector, mock_get, mock_list = _mock_duckdb_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        result = query_user_roles("my-duck")
        assert result["success"] is False

    @patch("altimate_engine.finops.role_access.ConnectionRegistry")
    def test_snowflake_success(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.return_value = [
            {"user_name": "alice", "role_name": "ANALYST"},
            {"user_name": "bob", "role_name": "ADMIN"},
        ]

        result = query_user_roles("my-sf")
        assert result["success"] is True
        assert result["assignment_count"] == 2

    @patch("altimate_engine.finops.role_access.ConnectionRegistry")
    def test_connector_error_handled(self, mock_registry):
        connector, mock_get, mock_list = _mock_snowflake_registry()
        mock_registry.get.side_effect = mock_get
        mock_registry.list.return_value = mock_list()
        connector.execute.side_effect = RuntimeError("timeout")

        result = query_user_roles("my-sf")
        assert result["success"] is False
        assert "timeout" in result["error"]
