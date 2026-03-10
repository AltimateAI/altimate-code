"""End-to-end tests for SQLite via SQLAlchemy connector."""

from connectors import SQLAlchemyConnector


class TestSQLiteEndToEnd:
    """Integration tests for SQLite via SQLAlchemy connector."""

    def test_connection_and_query(self, sqlite_path):
        """Test full flow: connect, create table, insert, query."""
        conn = SQLAlchemyConnector(
            url=f"sqlite:///{sqlite_path}",
            databases=["main"],
        )
        conn.validate("test")

        # SQLite doesn't need extra packages
        pkgs = conn.get_required_packages()
        assert pkgs == ["sqlalchemy"]

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
                    name TEXT,
                    value REAL
                )
            """)
            )
            _conn.execute(
                text("""
                INSERT INTO integration_test (name, value)
                VALUES ('alice', 10.50), ('bob', 20.75), ('charlie', 30.00)
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
            assert float(result["total"][0]) == 61.25

            # Test limit parameter
            result = run_sql("SELECT * FROM integration_test", limit=2)
            assert len(result) == 2

            # Test empty result
            result = run_sql("SELECT * FROM integration_test WHERE id = -1")
            assert len(result) == 0

        finally:
            _conn.close()

    def test_in_memory_database(self):
        """Test SQLite in-memory mode."""
        conn = SQLAlchemyConnector(
            url="sqlite:///:memory:",
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
            _conn.execute(text("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)"))
            _conn.execute(text("INSERT INTO test (name) VALUES ('a'), ('b'), ('c')"))
            _conn.commit()

            result = run_sql("SELECT COUNT(*) as cnt FROM test")
            assert int(result["cnt"][0]) == 3
        finally:
            _conn.close()

    def test_data_types(self, sqlite_path):
        """Test various SQLite data types are handled correctly."""
        conn = SQLAlchemyConnector(
            url=f"sqlite:///{sqlite_path}",
            databases=["main"],
        )

        prelude = conn.to_python_prelude()
        local_vars: dict = {}
        exec(prelude, local_vars)

        run_sql = local_vars["run_sql"]
        _conn = local_vars["_conn"]
        text = local_vars["text"]

        try:
            _conn.execute(
                text("""
                CREATE TABLE types_test (
                    int_col INTEGER,
                    real_col REAL,
                    text_col TEXT,
                    blob_col BLOB
                )
            """)
            )
            _conn.execute(
                text("""
                INSERT INTO types_test VALUES (42, 3.14, 'hello', X'DEADBEEF')
            """)
            )
            _conn.commit()

            result = run_sql("SELECT int_col, real_col, text_col FROM types_test")
            assert int(result["int_col"][0]) == 42
            assert float(result["real_col"][0]) == 3.14
            assert result["text_col"][0] == "hello"
        finally:
            _conn.close()
