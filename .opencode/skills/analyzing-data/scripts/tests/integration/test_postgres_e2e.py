"""End-to-end tests for PostgreSQL connector."""

import pytest

from connectors import PostgresConnector


class TestPostgresEndToEnd:
    """Integration tests for PostgreSQL connector with real database."""

    def test_connection_and_query(self, postgres_config):
        """Test full flow: connect, create table, insert, query."""
        conn = PostgresConnector(
            host=postgres_config["host"],
            port=postgres_config["port"],
            user=postgres_config["user"],
            password=postgres_config["password"],
            database=postgres_config["database"],
            databases=[postgres_config["database"]],
        )
        conn.validate("test")

        # Generate and execute prelude
        prelude = conn.to_python_prelude()
        local_vars: dict = {}
        exec(prelude, local_vars)

        run_sql = local_vars["run_sql"]
        run_sql_pandas = local_vars["run_sql_pandas"]
        _conn = local_vars["_conn"]

        try:
            # Create test table
            with _conn.cursor() as cursor:
                cursor.execute("DROP TABLE IF EXISTS integration_test")
                cursor.execute("""
                    CREATE TABLE integration_test (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(100),
                        value DECIMAL(10, 2)
                    )
                """)
                cursor.execute("""
                    INSERT INTO integration_test (name, value)
                    VALUES ('alice', 10.50), ('bob', 20.75), ('charlie', 30.00)
                """)

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
            assert float(result["total"][0]) == pytest.approx(61.25)

            # Test limit parameter
            result = run_sql("SELECT * FROM integration_test", limit=2)
            assert len(result) == 2

            # Test empty result
            result = run_sql("SELECT * FROM integration_test WHERE id = -1")
            assert len(result) == 0

        finally:
            # Cleanup
            with _conn.cursor() as cursor:
                cursor.execute("DROP TABLE IF EXISTS integration_test")
            _conn.close()

    def test_prelude_with_env_var_password(self, postgres_config, monkeypatch):
        """Test that password from env var works correctly."""
        monkeypatch.setenv("TEST_PG_PASSWORD", postgres_config["password"])

        conn = PostgresConnector.from_dict(
            {
                "host": postgres_config["host"],
                "port": postgres_config["port"],
                "user": postgres_config["user"],
                "password": "${TEST_PG_PASSWORD}",
                "database": postgres_config["database"],
            }
        )

        prelude = conn.to_python_prelude()
        assert "os.environ.get" in prelude
        assert "TEST_PG_PASSWORD" in prelude

        # Execute with env var injected
        env_vars = conn.get_env_vars_for_kernel()
        local_vars: dict = {}
        for key, value in env_vars.items():
            monkeypatch.setenv(key, value)

        exec(prelude, local_vars)
        result = local_vars["run_sql"]("SELECT 1 as test")
        assert len(result) == 1
        local_vars["_conn"].close()
