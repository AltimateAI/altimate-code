"""End-to-end tests for DuckDB via SQLAlchemy connector."""

import pytest

from connectors import SQLAlchemyConnector


class TestDuckDBEndToEnd:
    """Integration tests for DuckDB via SQLAlchemy connector."""

    def test_connection_and_query(self, duckdb_path):
        """Test full flow: connect, create table, insert, query."""
        conn = SQLAlchemyConnector(
            url=f"duckdb:///{duckdb_path}",
            databases=["main"],
        )
        conn.validate("test")

        # Verify package detection
        pkgs = conn.get_required_packages()
        assert "duckdb" in pkgs
        assert "duckdb-engine" in pkgs

        # Generate and execute prelude
        prelude = conn.to_python_prelude()
        local_vars: dict = {}
        exec(prelude, local_vars)

        run_sql = local_vars["run_sql"]
        run_sql_pandas = local_vars["run_sql_pandas"]
        _conn = local_vars["_conn"]
        text = local_vars["text"]

        try:
            # Create test table
            _conn.execute(
                text("""
                CREATE TABLE integration_test (
                    id INTEGER PRIMARY KEY,
                    name VARCHAR,
                    value DECIMAL(10, 2)
                )
            """)
            )
            _conn.execute(
                text("""
                INSERT INTO integration_test VALUES
                (1, 'alice', 10.50),
                (2, 'bob', 20.75),
                (3, 'charlie', 30.00)
            """)
            )
            _conn.commit()

            # Test run_sql returns Polars
            result = run_sql("SELECT * FROM integration_test ORDER BY id")
            assert len(result) == 3
            assert "polars" in str(type(result)).lower()
            assert result["name"].to_list() == ["alice", "bob", "charlie"]

            # Test run_sql_pandas returns Pandas
            result_pd = run_sql_pandas("SELECT * FROM integration_test ORDER BY id")
            assert len(result_pd) == 3
            assert "dataframe" in str(type(result_pd)).lower()

            # Test aggregation
            result = run_sql("SELECT SUM(value) as total FROM integration_test")
            total = float(result["total"][0])
            assert total == pytest.approx(61.25)

            # Test limit parameter
            result = run_sql("SELECT * FROM integration_test", limit=2)
            assert len(result) == 2

            # Test empty result
            result = run_sql("SELECT * FROM integration_test WHERE id = -1")
            assert len(result) == 0

            # DuckDB-specific: test COPY export (parquet support)
            result = run_sql("SELECT COUNT(*) as cnt FROM integration_test")
            assert int(result["cnt"][0]) == 3

        finally:
            _conn.close()

    def test_in_memory_database(self):
        """Test DuckDB in-memory mode."""
        try:
            import duckdb  # noqa: F401
        except ImportError:
            pytest.skip("duckdb not installed")

        conn = SQLAlchemyConnector(
            url="duckdb:///:memory:",
            databases=["memory"],
        )
        conn.validate("test")

        prelude = conn.to_python_prelude()
        local_vars: dict = {}
        exec(prelude, local_vars)

        run_sql = local_vars["run_sql"]
        _conn = local_vars["_conn"]
        text = local_vars["text"]

        try:
            _conn.execute(text("CREATE TABLE test (id INT)"))
            _conn.execute(text("INSERT INTO test VALUES (1), (2), (3)"))
            _conn.commit()

            result = run_sql("SELECT COUNT(*) as cnt FROM test")
            assert int(result["cnt"][0]) == 3
        finally:
            _conn.close()
