"""Tests for DuckDB connector (in-memory, no external deps)."""

import pytest


class TestDuckDBConnector:
    def test_connect_and_execute(self):
        from altimate_engine.connectors.duckdb import DuckDBConnector

        conn = DuckDBConnector(path=":memory:")
        conn.connect()
        result = conn.execute("SELECT 1 AS num")
        assert len(result) == 1
        assert result[0]["num"] == 1
        conn.close()

    def test_context_manager(self):
        from altimate_engine.connectors.duckdb import DuckDBConnector

        with DuckDBConnector(path=":memory:") as conn:
            result = conn.execute("SELECT 42 AS answer")
            assert result[0]["answer"] == 42

    def test_list_schemas(self):
        from altimate_engine.connectors.duckdb import DuckDBConnector

        with DuckDBConnector(path=":memory:") as conn:
            schemas = conn.list_schemas()
            assert isinstance(schemas, list)
            assert "main" in schemas

    def test_list_tables(self):
        from altimate_engine.connectors.duckdb import DuckDBConnector

        with DuckDBConnector(path=":memory:") as conn:
            conn.execute("CREATE TABLE test_table (id INT, name VARCHAR)")
            tables = conn.list_tables("main")
            names = [t["name"] for t in tables]
            assert "test_table" in names

    def test_describe_table(self):
        from altimate_engine.connectors.duckdb import DuckDBConnector

        with DuckDBConnector(path=":memory:") as conn:
            conn.execute("CREATE TABLE test_desc (id INTEGER NOT NULL, name VARCHAR)")
            cols = conn.describe_table("main", "test_desc")
            assert len(cols) == 2
            col_names = [c["name"] for c in cols]
            assert "id" in col_names
            assert "name" in col_names

    def test_parameterized_query(self):
        """Verify params argument works in execute()."""
        from altimate_engine.connectors.duckdb import DuckDBConnector

        with DuckDBConnector(path=":memory:") as conn:
            conn.execute("CREATE TABLE param_test (id INT, val VARCHAR)")
            conn.execute("INSERT INTO param_test VALUES (1, 'a'), (2, 'b'), (3, 'c')")
            result = conn.execute("SELECT * FROM param_test WHERE id = ?", params=(2,))
            assert len(result) == 1
            assert result[0]["val"] == "b"

    def test_limit_parameter(self):
        from altimate_engine.connectors.duckdb import DuckDBConnector

        with DuckDBConnector(path=":memory:") as conn:
            conn.execute("CREATE TABLE limit_test AS SELECT * FROM range(100) t(id)")
            result = conn.execute("SELECT * FROM limit_test", limit=5)
            assert len(result) == 5

    def test_ddl_returns_empty(self):
        from altimate_engine.connectors.duckdb import DuckDBConnector

        with DuckDBConnector(path=":memory:") as conn:
            result = conn.execute("CREATE TABLE ddl_test (id INT)")
            assert result == []


class TestConnectorBaseInterface:
    def test_params_in_signature(self):
        """Verify the base Connector.execute has params argument."""
        from altimate_engine.connectors.base import Connector
        import inspect

        sig = inspect.signature(Connector.execute)
        assert "params" in sig.parameters
