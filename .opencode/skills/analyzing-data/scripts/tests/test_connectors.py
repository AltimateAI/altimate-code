"""Tests for database connectors."""

import tempfile
from pathlib import Path

import pytest

from connectors import (
    BigQueryConnector,
    PostgresConnector,
    SnowflakeConnector,
    SQLAlchemyConnector,
    create_connector,
    get_connector_class,
    list_connector_types,
)


class TestRegistry:
    def test_list_connector_types(self):
        types = list_connector_types()
        assert "snowflake" in types
        assert "postgres" in types
        assert "bigquery" in types
        assert "sqlalchemy" in types

    def test_get_connector_class(self):
        assert get_connector_class("snowflake") == SnowflakeConnector
        assert get_connector_class("postgres") == PostgresConnector
        assert get_connector_class("bigquery") == BigQueryConnector
        assert get_connector_class("sqlalchemy") == SQLAlchemyConnector

    def test_get_connector_class_unknown(self):
        with pytest.raises(ValueError, match="Unknown connector type"):
            get_connector_class("unknown")

    def test_create_connector_default_type(self):
        # Default type is snowflake
        conn = create_connector({"account": "test", "user": "u", "password": "p"})
        assert isinstance(conn, SnowflakeConnector)

    def test_create_connector_explicit_type(self):
        conn = create_connector(
            {"type": "postgres", "host": "h", "user": "u", "database": "d"}
        )
        assert isinstance(conn, PostgresConnector)


class TestSnowflakeConnector:
    def test_connector_type(self):
        assert SnowflakeConnector.connector_type() == "snowflake"

    def test_from_dict_password_auth(self):
        data = {
            "type": "snowflake",
            "account": "my-account",
            "user": "my-user",
            "password": "my-password",
            "warehouse": "COMPUTE_WH",
            "databases": ["DB1"],
        }
        conn = SnowflakeConnector.from_dict(data)
        assert conn.account == "my-account"
        assert conn.user == "my-user"
        assert conn.password == "my-password"
        assert conn.warehouse == "COMPUTE_WH"
        assert conn.databases == ["DB1"]
        assert conn.auth_type == "password"

    def test_validate_missing_account(self):
        conn = SnowflakeConnector(account="", user="u", password="p", databases=[])
        with pytest.raises(ValueError, match="account required"):
            conn.validate("test")

    def test_validate_missing_password(self):
        conn = SnowflakeConnector(account="a", user="u", password="", databases=[])
        with pytest.raises(ValueError, match="password required"):
            conn.validate("test")

    def test_validate_private_key_auth(self):
        conn = SnowflakeConnector(
            account="a",
            user="u",
            auth_type="private_key",
            private_key="key",
            databases=[],
        )
        conn.validate("test")  # Should pass

    def test_get_required_packages_password(self):
        conn = SnowflakeConnector(account="a", user="u", password="p", databases=[])
        assert conn.get_required_packages() == ["snowflake-connector-python[pandas]"]

    def test_get_required_packages_private_key(self):
        conn = SnowflakeConnector(
            account="a",
            user="u",
            auth_type="private_key",
            private_key="k",
            databases=[],
        )
        pkgs = conn.get_required_packages()
        assert "cryptography" in pkgs

    def test_to_python_prelude_contains_connection(self):
        conn = SnowflakeConnector(
            account="test-account",
            user="test-user",
            password="test-pass",
            warehouse="WH",
            databases=["DB"],
        )
        prelude = conn.to_python_prelude()
        assert "import snowflake.connector" in prelude
        assert "snowflake.connector.connect" in prelude
        assert "account='test-account'" in prelude
        assert "def run_sql" in prelude

    @pytest.mark.parametrize(
        "data,expected_tag",
        [
            (
                {
                    "account": "a",
                    "user": "u",
                    "password": "p",
                    "query_tag": "team=data-eng",
                },
                "team=data-eng",
            ),
            ({"account": "a", "user": "u", "password": "p"}, ""),
        ],
        ids=["with_query_tag", "without_query_tag"],
    )
    def test_from_dict_query_tag(self, data, expected_tag):
        conn = SnowflakeConnector.from_dict(data)
        assert conn.query_tag == expected_tag

    @pytest.mark.parametrize(
        "query_tag",
        [
            "team=data-eng",
            "x" * 2000,
            "",
        ],
        ids=["typical_tag", "max_length", "empty"],
    )
    def test_validate_valid_query_tag(self, query_tag):
        conn = SnowflakeConnector(
            account="a", user="u", password="p", databases=[], query_tag=query_tag
        )
        conn.validate("test")  # Should not raise

    def test_validate_invalid_query_tag(self):
        conn = SnowflakeConnector(
            account="a",
            user="u",
            password="p",
            databases=[],
            query_tag="x" * 2001,
        )
        with pytest.raises(ValueError, match="2000 character limit"):
            conn.validate("test")

    def test_to_python_prelude_with_query_tag(self):
        conn = SnowflakeConnector(
            account="a",
            user="u",
            password="p",
            databases=["DB"],
            query_tag="team=data-eng",
        )
        prelude = conn.to_python_prelude()
        assert "session_parameters" in prelude
        assert "QUERY_TAG" in prelude
        assert "team=data-eng" in prelude

    def test_to_python_prelude_query_tag_in_status(self):
        conn = SnowflakeConnector(
            account="a",
            user="u",
            password="p",
            databases=["DB"],
            query_tag="team=data-eng",
        )
        prelude = conn.to_python_prelude()
        assert "Query Tag:" in prelude


class TestPostgresConnector:
    def test_connector_type(self):
        assert PostgresConnector.connector_type() == "postgres"

    def test_from_dict(self):
        data = {
            "type": "postgres",
            "host": "db.example.com",
            "port": 5432,
            "user": "analyst",
            "password": "secret",
            "database": "analytics",
            "sslmode": "require",
        }
        conn = PostgresConnector.from_dict(data)
        assert conn.host == "db.example.com"
        assert conn.port == 5432
        assert conn.user == "analyst"
        assert conn.database == "analytics"
        assert conn.sslmode == "require"
        assert conn.databases == ["analytics"]

    def test_validate_missing_host(self):
        conn = PostgresConnector(host="", user="u", database="d", databases=[])
        with pytest.raises(ValueError, match="host required"):
            conn.validate("test")

    def test_validate_missing_database(self):
        conn = PostgresConnector(host="h", user="u", database="", databases=[])
        with pytest.raises(ValueError, match="database required"):
            conn.validate("test")

    def test_get_required_packages(self):
        conn = PostgresConnector(host="h", user="u", database="d", databases=[])
        assert conn.get_required_packages() == ["psycopg[binary,pool]"]

    def test_to_python_prelude_contains_connection(self):
        conn = PostgresConnector(
            host="localhost",
            port=5432,
            user="user",
            database="mydb",
            databases=["mydb"],
        )
        prelude = conn.to_python_prelude()
        assert "import psycopg" in prelude
        assert "psycopg.connect" in prelude
        assert "host='localhost'" in prelude
        assert "def run_sql" in prelude

    @pytest.mark.parametrize(
        "data,expected_name",
        [
            (
                {
                    "host": "h",
                    "user": "u",
                    "database": "d",
                    "application_name": "claude-code",
                },
                "claude-code",
            ),
            ({"host": "h", "user": "u", "database": "d"}, ""),
        ],
        ids=["with_application_name", "without_application_name"],
    )
    def test_from_dict_application_name(self, data, expected_name):
        conn = PostgresConnector.from_dict(data)
        assert conn.application_name == expected_name

    def test_to_python_prelude_with_application_name(self):
        conn = PostgresConnector(
            host="h",
            user="u",
            database="db",
            databases=["db"],
            application_name="claude-code",
        )
        prelude = conn.to_python_prelude()
        assert "application_name='claude-code'" in prelude

    def test_to_python_prelude_application_name_in_status(self):
        conn = PostgresConnector(
            host="h",
            user="u",
            database="db",
            databases=["db"],
            application_name="claude-code",
        )
        prelude = conn.to_python_prelude()
        assert "Application:" in prelude


class TestBigQueryConnector:
    def test_connector_type(self):
        assert BigQueryConnector.connector_type() == "bigquery"

    def test_from_dict(self):
        data = {
            "type": "bigquery",
            "project": "my-gcp-project",
            "location": "US",
        }
        conn = BigQueryConnector.from_dict(data)
        assert conn.project == "my-gcp-project"
        assert conn.location == "US"
        assert conn.databases == ["my-gcp-project"]

    def test_validate_missing_project(self):
        conn = BigQueryConnector(project="", databases=[])
        with pytest.raises(ValueError, match="project required"):
            conn.validate("test")

    def test_get_required_packages(self):
        conn = BigQueryConnector(project="p", databases=[])
        pkgs = conn.get_required_packages()
        assert "google-cloud-bigquery[pandas,pyarrow]" in pkgs
        assert "db-dtypes" in pkgs

    def test_to_python_prelude_contains_client(self):
        conn = BigQueryConnector(project="my-project", databases=["my-project"])
        prelude = conn.to_python_prelude()
        assert "from google.cloud import bigquery" in prelude
        assert "bigquery.Client" in prelude
        assert "def run_sql" in prelude

    def test_to_python_prelude_with_credentials(self):
        conn = BigQueryConnector(
            project="my-project",
            credentials_path="/path/to/creds.json",
            databases=["my-project"],
        )
        prelude = conn.to_python_prelude()
        assert "service_account" in prelude
        assert "from_service_account_file" in prelude

    @pytest.mark.parametrize(
        "data,expected_labels",
        [
            (
                {"project": "p", "labels": {"team": "data-eng", "env": "prod"}},
                {"team": "data-eng", "env": "prod"},
            ),
            ({"project": "p"}, {}),
        ],
        ids=["with_labels", "without_labels"],
    )
    def test_from_dict_labels(self, data, expected_labels):
        conn = BigQueryConnector.from_dict(data)
        assert conn.labels == expected_labels

    @pytest.mark.parametrize(
        "labels",
        [
            {"team": "data-eng", "env": "prod", "tool": "claude-code"},
            {"team": ""},
        ],
        ids=["typical_labels", "empty_value"],
    )
    def test_validate_valid_labels(self, labels):
        conn = BigQueryConnector(project="p", databases=[], labels=labels)
        conn.validate("test")  # Should not raise

    @pytest.mark.parametrize(
        "labels,error_match",
        [
            ({"Team": "eng"}, "invalid BigQuery label key"),
            ({"1team": "eng"}, "invalid BigQuery label key"),
            ({"team": "Eng"}, "invalid BigQuery label value"),
            ({f"key{i}": f"val{i}" for i in range(65)}, "at most 64 labels"),
            ({"team": 12345}, "must be a string"),
        ],
        ids=[
            "uppercase_key",
            "key_starts_with_number",
            "uppercase_value",
            "too_many_labels",
            "non_string_value",
        ],
    )
    def test_validate_invalid_labels(self, labels, error_match):
        conn = BigQueryConnector(project="p", databases=[], labels=labels)
        with pytest.raises(ValueError, match=error_match):
            conn.validate("test")

    def test_to_python_prelude_with_labels(self):
        conn = BigQueryConnector(
            project="p",
            databases=["p"],
            labels={"team": "data-eng", "env": "prod"},
        )
        prelude = conn.to_python_prelude()
        assert "labels=" in prelude
        assert "'team': 'data-eng'" in prelude
        assert "'env': 'prod'" in prelude

    def test_to_python_prelude_location_in_query_call(self):
        conn = BigQueryConnector(project="p", location="US", databases=["p"])
        prelude = conn.to_python_prelude()
        assert "location='US'" in prelude
        # location should be in _client.query(), not QueryJobConfig()
        assert "_client.query(query, job_config=job_config, location='US')" in prelude

    def test_to_python_prelude_location_and_labels(self):
        conn = BigQueryConnector(
            project="p",
            location="EU",
            databases=["p"],
            labels={"team": "eng"},
        )
        prelude = conn.to_python_prelude()
        compile(prelude, "<string>", "exec")
        assert "labels={'team': 'eng'}" in prelude
        assert "location='EU'" in prelude
        assert "_client.query(query, job_config=job_config, location='EU')" in prelude

    def test_to_python_prelude_labels_in_status(self):
        conn = BigQueryConnector(
            project="p",
            databases=["p"],
            labels={"team": "data-eng"},
        )
        prelude = conn.to_python_prelude()
        assert "Labels:" in prelude


class TestSQLAlchemyConnector:
    def test_connector_type(self):
        assert SQLAlchemyConnector.connector_type() == "sqlalchemy"

    def test_from_dict(self):
        data = {
            "type": "sqlalchemy",
            "url": "sqlite:///test.db",
            "databases": ["test"],
        }
        conn = SQLAlchemyConnector.from_dict(data)
        assert conn.url == "sqlite:///test.db"
        assert conn.databases == ["test"]

    def test_validate_missing_url(self):
        conn = SQLAlchemyConnector(url="", databases=["d"])
        with pytest.raises(ValueError, match="url required"):
            conn.validate("test")

    def test_validate_missing_databases(self):
        conn = SQLAlchemyConnector(url="sqlite:///t.db", databases=[])
        with pytest.raises(ValueError, match="databases list required"):
            conn.validate("test")

    def test_get_required_packages_sqlite(self):
        conn = SQLAlchemyConnector(url="sqlite:///t.db", databases=["t"])
        pkgs = conn.get_required_packages()
        assert "sqlalchemy" in pkgs
        assert len(pkgs) == 1  # sqlite is built-in

    def test_get_required_packages_postgres(self):
        conn = SQLAlchemyConnector(url="postgresql://u:p@h/d", databases=["d"])
        pkgs = conn.get_required_packages()
        assert "sqlalchemy" in pkgs
        assert "psycopg[binary]" in pkgs

    def test_get_required_packages_mysql(self):
        conn = SQLAlchemyConnector(url="mysql+pymysql://u:p@h/d", databases=["d"])
        pkgs = conn.get_required_packages()
        assert "sqlalchemy" in pkgs
        assert "pymysql" in pkgs

    def test_get_required_packages_duckdb(self):
        conn = SQLAlchemyConnector(url="duckdb:///data.duckdb", databases=["main"])
        pkgs = conn.get_required_packages()
        assert "duckdb" in pkgs
        assert "duckdb-engine" in pkgs

    def test_to_python_prelude_contains_engine(self):
        conn = SQLAlchemyConnector(url="sqlite:///test.db", databases=["test"])
        prelude = conn.to_python_prelude()
        assert "from sqlalchemy import create_engine" in prelude
        assert "create_engine" in prelude
        assert "def run_sql" in prelude

    @pytest.mark.parametrize(
        "data,expected_args",
        [
            (
                {
                    "url": "postgresql://u:p@h/d",
                    "databases": ["d"],
                    "connect_args": {"application_name": "claude-code"},
                },
                {"application_name": "claude-code"},
            ),
            (
                {"url": "postgresql://u:p@h/d", "databases": ["d"]},
                {},
            ),
        ],
        ids=["with_connect_args", "without_connect_args"],
    )
    def test_from_dict_connect_args(self, data, expected_args):
        conn = SQLAlchemyConnector.from_dict(data)
        assert conn.connect_args == expected_args

    def test_to_python_prelude_with_connect_args(self):
        conn = SQLAlchemyConnector(
            url="postgresql://u:p@h/d",
            databases=["d"],
            connect_args={"application_name": "claude-code"},
        )
        prelude = conn.to_python_prelude()
        assert "connect_args={'application_name': 'claude-code'}" in prelude

    def test_to_python_prelude_without_connect_args(self):
        conn = SQLAlchemyConnector(url="sqlite:///t.db", databases=["t"])
        prelude = conn.to_python_prelude()
        assert "connect_args" not in prelude

    def test_to_python_prelude_nested_connect_args(self):
        conn = SQLAlchemyConnector(
            url="snowflake://u:p@a/d",
            databases=["d"],
            connect_args={"session_parameters": {"QUERY_TAG": "team=data-eng"}},
        )
        prelude = conn.to_python_prelude()
        assert "connect_args=" in prelude
        assert "QUERY_TAG" in prelude
        assert "team=data-eng" in prelude


class TestEnvVarSubstitution:
    def test_env_var_substitution(self, monkeypatch):
        monkeypatch.setenv("TEST_PASSWORD", "secret123")
        data = {
            "type": "postgres",
            "host": "localhost",
            "user": "user",
            "password": "${TEST_PASSWORD}",
            "database": "db",
        }
        conn = PostgresConnector.from_dict(data)
        assert conn.password == "secret123"
        assert conn.password_env_var == "TEST_PASSWORD"

    def test_env_var_injected_to_kernel(self, monkeypatch):
        monkeypatch.setenv("TEST_PW", "secret")
        data = {
            "type": "postgres",
            "host": "h",
            "user": "u",
            "password": "${TEST_PW}",
            "database": "d",
        }
        conn = PostgresConnector.from_dict(data)
        env_vars = conn.get_env_vars_for_kernel()
        assert env_vars.get("TEST_PW") == "secret"


class TestUnresolvedEnvVarValidation:
    """Validation must catch unresolved ${VAR} patterns to fail fast."""

    @pytest.mark.parametrize(
        "connector_cls,kwargs,error_match",
        [
            (
                SnowflakeConnector,
                {"account": "${X}", "user": "u", "password": "p", "databases": []},
                "account required",
            ),
            (
                SnowflakeConnector,
                {"account": "a", "user": "${X}", "password": "p", "databases": []},
                "user required",
            ),
            (
                SnowflakeConnector,
                {"account": "a", "user": "u", "password": "${X}", "databases": []},
                "password required",
            ),
            (
                PostgresConnector,
                {"host": "${X}", "user": "u", "database": "d", "databases": []},
                "host required",
            ),
            (
                PostgresConnector,
                {"host": "h", "user": "${X}", "database": "d", "databases": []},
                "user required",
            ),
            (
                PostgresConnector,
                {"host": "h", "user": "u", "database": "${X}", "databases": []},
                "database required",
            ),
            (
                BigQueryConnector,
                {"project": "${X}", "databases": []},
                "project required",
            ),
            (SQLAlchemyConnector, {"url": "${X}", "databases": ["d"]}, "url required"),
        ],
        ids=[
            "snowflake_account",
            "snowflake_user",
            "snowflake_password",
            "postgres_host",
            "postgres_user",
            "postgres_database",
            "bigquery_project",
            "sqlalchemy_url",
        ],
    )
    def test_unresolved_env_var_fails_validation(
        self, connector_cls, kwargs, error_match
    ):
        conn = connector_cls(**kwargs)
        with pytest.raises(ValueError, match=error_match):
            conn.validate("test")


class TestGetEnvVarsForKernel:
    """Tests for get_env_vars_for_kernel() across all connectors."""

    def test_snowflake_password_env_var(self, monkeypatch):
        monkeypatch.setenv("SF_PASS", "secret")
        conn = SnowflakeConnector.from_dict(
            {
                "account": "a",
                "user": "u",
                "password": "${SF_PASS}",
            }
        )
        env_vars = conn.get_env_vars_for_kernel()
        assert env_vars == {"SF_PASS": "secret"}

    def test_snowflake_private_key_env_var(self, monkeypatch):
        monkeypatch.setenv("SF_KEY", "my-private-key")
        conn = SnowflakeConnector.from_dict(
            {
                "account": "a",
                "user": "u",
                "auth_type": "private_key",
                "private_key": "${SF_KEY}",
            }
        )
        env_vars = conn.get_env_vars_for_kernel()
        assert env_vars == {"SF_KEY": "my-private-key"}

    def test_snowflake_all_env_vars(self, monkeypatch):
        monkeypatch.setenv("SF_KEY", "key")
        monkeypatch.setenv("SF_PASS", "passphrase")
        conn = SnowflakeConnector.from_dict(
            {
                "account": "a",
                "user": "u",
                "auth_type": "private_key",
                "private_key": "${SF_KEY}",
                "private_key_passphrase": "${SF_PASS}",
            }
        )
        env_vars = conn.get_env_vars_for_kernel()
        assert "SF_KEY" in env_vars
        assert "SF_PASS" in env_vars

    def test_snowflake_no_env_vars_when_literal(self):
        conn = SnowflakeConnector(
            account="a", user="u", password="literal-pass", databases=[]
        )
        env_vars = conn.get_env_vars_for_kernel()
        assert env_vars == {}

    def test_postgres_password_env_var(self, monkeypatch):
        monkeypatch.setenv("PG_PASS", "secret")
        conn = PostgresConnector.from_dict(
            {
                "host": "h",
                "user": "u",
                "password": "${PG_PASS}",
                "database": "d",
            }
        )
        env_vars = conn.get_env_vars_for_kernel()
        assert env_vars == {"PG_PASS": "secret"}

    def test_postgres_no_env_vars_when_literal(self):
        conn = PostgresConnector(
            host="h", user="u", password="literal", database="d", databases=[]
        )
        env_vars = conn.get_env_vars_for_kernel()
        assert env_vars == {}

    def test_bigquery_credentials_path_env_var(self):
        conn = BigQueryConnector(
            project="p", credentials_path="/path/to/creds.json", databases=[]
        )
        env_vars = conn.get_env_vars_for_kernel()
        assert env_vars == {"GOOGLE_APPLICATION_CREDENTIALS": "/path/to/creds.json"}

    def test_bigquery_no_env_vars_without_creds(self):
        conn = BigQueryConnector(project="p", databases=[])
        env_vars = conn.get_env_vars_for_kernel()
        assert env_vars == {}

    def test_sqlalchemy_url_env_var(self, monkeypatch):
        monkeypatch.setenv("DB_URL", "postgresql://u:p@h/d")
        conn = SQLAlchemyConnector.from_dict(
            {
                "url": "${DB_URL}",
                "databases": ["d"],
            }
        )
        env_vars = conn.get_env_vars_for_kernel()
        assert env_vars == {"DB_URL": "postgresql://u:p@h/d"}


class TestSnowflakePrivateKeyPrelude:
    """Tests for Snowflake private key authentication prelude variations."""

    def test_private_key_from_file_compiles(self):
        conn = SnowflakeConnector(
            account="a",
            user="u",
            auth_type="private_key",
            private_key_path="/path/to/key.pem",
            databases=[],
        )
        prelude = conn.to_python_prelude()
        compile(prelude, "<string>", "exec")
        assert "_load_private_key" in prelude
        assert "/path/to/key.pem" in prelude

    def test_private_key_from_file_with_passphrase_compiles(self):
        conn = SnowflakeConnector(
            account="a",
            user="u",
            auth_type="private_key",
            private_key_path="/path/to/key.pem",
            private_key_passphrase="mypassphrase",
            databases=[],
        )
        prelude = conn.to_python_prelude()
        compile(prelude, "<string>", "exec")
        assert "mypassphrase" in prelude

    def test_private_key_from_content_compiles(self):
        conn = SnowflakeConnector(
            account="a",
            user="u",
            auth_type="private_key",
            private_key="-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
            databases=[],
        )
        prelude = conn.to_python_prelude()
        compile(prelude, "<string>", "exec")
        assert "_load_private_key" in prelude

    def test_private_key_from_env_var_compiles(self, monkeypatch):
        monkeypatch.setenv("SF_PRIVATE_KEY", "key-content")
        conn = SnowflakeConnector.from_dict(
            {
                "account": "a",
                "user": "u",
                "auth_type": "private_key",
                "private_key": "${SF_PRIVATE_KEY}",
            }
        )
        prelude = conn.to_python_prelude()
        compile(prelude, "<string>", "exec")
        assert "os.environ.get" in prelude
        assert "SF_PRIVATE_KEY" in prelude

    def test_private_key_passphrase_from_env_var_compiles(self, monkeypatch):
        monkeypatch.setenv("SF_PASSPHRASE", "secret")
        conn = SnowflakeConnector.from_dict(
            {
                "account": "a",
                "user": "u",
                "auth_type": "private_key",
                "private_key_path": "/path/to/key.pem",
                "private_key_passphrase": "${SF_PASSPHRASE}",
            }
        )
        prelude = conn.to_python_prelude()
        compile(prelude, "<string>", "exec")
        assert "SF_PASSPHRASE" in prelude


class TestSQLAlchemyPackageDetection:
    """SQLAlchemy connector must detect correct driver packages from URL."""

    @pytest.mark.parametrize(
        "url,expected_driver",
        [
            ("mssql+pyodbc://u:p@h/d", "pyodbc"),
            ("oracle+oracledb://u:p@h/d", "oracledb"),
            ("mysql+mysqlconnector://u:p@h/d", "mysql-connector-python"),
            ("mysql+pymysql://u:p@h/d", "pymysql"),
            ("postgres://u:p@h/d", "psycopg[binary]"),
            ("postgresql://u:p@h/d", "psycopg[binary]"),
            ("duckdb:///data.db", "duckdb"),
            ("redshift+redshift_connector://u:p@h:5439/d", "redshift_connector"),
            ("snowflake://u:p@h/d", "snowflake-sqlalchemy"),
            ("trino://u:p@h/d", "trino"),
            ("clickhouse://u:p@h/d", "clickhouse-driver"),
            ("cockroachdb://u:p@h/d", "sqlalchemy-cockroachdb"),
            ("awsathena://u:p@h/d", "pyathena"),
        ],
        ids=[
            "mssql",
            "oracle",
            "mysql_connector",
            "mysql_pymysql",
            "postgres",
            "postgresql",
            "duckdb",
            "redshift",
            "snowflake",
            "trino",
            "clickhouse",
            "cockroachdb",
            "awsathena",
        ],
    )
    def test_driver_package_detected(self, url, expected_driver):
        conn = SQLAlchemyConnector(url=url, databases=["d"])
        pkgs = conn.get_required_packages()
        assert "sqlalchemy" in pkgs
        assert expected_driver in pkgs

    def test_unknown_dialect_only_sqlalchemy(self):
        conn = SQLAlchemyConnector(url="unknown://u:p@h/d", databases=["d"])
        assert conn.get_required_packages() == ["sqlalchemy"]

    @pytest.mark.parametrize(
        "url",
        [
            "notaurl",
            "postgresql:",
            "",
            "://missing-dialect",
        ],
        ids=["no_scheme", "no_slashes", "empty", "empty_dialect"],
    )
    def test_malformed_url_returns_only_sqlalchemy(self, url):
        """Malformed URLs should gracefully fall back to just sqlalchemy."""
        conn = SQLAlchemyConnector(url=url, databases=["d"])
        assert conn.get_required_packages() == ["sqlalchemy"]

    def test_pool_size_in_prelude(self):
        """pool_size parameter should be passed to create_engine."""
        conn = SQLAlchemyConnector(url="sqlite:///t.db", databases=["t"], pool_size=10)
        prelude = conn.to_python_prelude()
        assert "pool_size=10" in prelude

    def test_echo_in_prelude(self):
        """echo parameter should be passed to create_engine."""
        conn = SQLAlchemyConnector(url="sqlite:///t.db", databases=["t"], echo=True)
        prelude = conn.to_python_prelude()
        assert "echo=True" in prelude

    def test_atexit_cleanup_in_prelude(self):
        """Connection cleanup should be registered with atexit."""
        conn = SQLAlchemyConnector(url="sqlite:///t.db", databases=["t"])
        prelude = conn.to_python_prelude()
        assert "atexit.register" in prelude
        assert "_conn.close()" in prelude
        assert "_engine.dispose()" in prelude

    @pytest.mark.parametrize(
        "url,expected_display",
        [
            ("sqlite:///t.db", "SQLite"),
            ("postgresql://u:p@h/d", "PostgreSQL"),
            ("mysql://u:p@h/d", "MySQL"),
            ("redshift://u:p@h/d", "Redshift"),
            ("snowflake://u:p@h/d", "Snowflake"),
            ("trino://u:p@h/d", "Trino"),
            ("clickhouse://u:p@h/d", "ClickHouse"),
            ("unknown://u:p@h/d", "Database"),
        ],
        ids=[
            "sqlite",
            "postgresql",
            "mysql",
            "redshift",
            "snowflake",
            "trino",
            "clickhouse",
            "unknown",
        ],
    )
    def test_display_name_in_prelude(self, url, expected_display):
        """Status message should show correct database name."""
        conn = SQLAlchemyConnector(url=url, databases=["d"])
        prelude = conn.to_python_prelude()
        assert f"{expected_display} connection established" in prelude


class TestConnectorDefaults:
    """Connectors must have sensible defaults for optional fields."""

    def test_postgres_default_port(self):
        conn = PostgresConnector.from_dict({"host": "h", "user": "u", "database": "d"})
        assert conn.port == 5432

    def test_postgres_custom_port(self):
        conn = PostgresConnector.from_dict(
            {"host": "h", "port": 5433, "user": "u", "database": "d"}
        )
        assert conn.port == 5433

    @pytest.mark.parametrize(
        "connector_cls,config,expected_databases",
        [
            (
                PostgresConnector,
                {"host": "h", "user": "u", "database": "mydb"},
                ["mydb"],
            ),
            (
                PostgresConnector,
                {"host": "h", "user": "u", "database": "mydb", "databases": ["a", "b"]},
                ["a", "b"],
            ),
            (BigQueryConnector, {"project": "my-project"}, ["my-project"]),
            (
                BigQueryConnector,
                {"project": "p", "databases": ["d1", "d2"]},
                ["d1", "d2"],
            ),
        ],
        ids=[
            "postgres_default",
            "postgres_override",
            "bigquery_default",
            "bigquery_override",
        ],
    )
    def test_databases_list_defaults(self, connector_cls, config, expected_databases):
        conn = connector_cls.from_dict(config)
        assert conn.databases == expected_databases

    def test_bigquery_empty_location_by_default(self):
        conn = BigQueryConnector.from_dict({"project": "p"})
        assert conn.location == ""


class TestPreludeCompilation:
    """Generated prelude code must be valid Python syntax."""

    @pytest.mark.parametrize(
        "connector",
        [
            SnowflakeConnector(
                account="a", user="u", password="p", warehouse="WH", databases=["DB"]
            ),
            SnowflakeConnector(
                account="a",
                user="u",
                auth_type="private_key",
                private_key_path="/k.pem",
                databases=[],
            ),
            SnowflakeConnector(
                account="a",
                user="u",
                password="p",
                query_tag="team=data-eng",
                databases=[],
            ),
            PostgresConnector(
                host="h", port=5432, user="u", database="db", databases=["db"]
            ),
            PostgresConnector(
                host="h",
                user="u",
                password="p",
                database="db",
                sslmode="require",
                databases=[],
            ),
            PostgresConnector(
                host="h",
                user="u",
                password="p",
                database="db",
                databases=[],
                application_name="claude-code",
            ),
            BigQueryConnector(project="p", databases=["p"]),
            BigQueryConnector(project="p", location="US", databases=["p"]),
            BigQueryConnector(
                project="p", credentials_path="/creds.json", databases=["p"]
            ),
            BigQueryConnector(
                project="p",
                databases=["p"],
                labels={"team": "data-eng", "env": "prod"},
            ),
            BigQueryConnector(
                project="p",
                location="EU",
                databases=["p"],
                labels={"tool": "claude-code"},
            ),
            SQLAlchemyConnector(url="sqlite:///test.db", databases=["test"]),
            SQLAlchemyConnector(url="postgresql://u:p@h/d", databases=["d"]),
            SQLAlchemyConnector(
                url="postgresql://u:p@h/d",
                databases=["d"],
                connect_args={"application_name": "claude-code"},
            ),
            SQLAlchemyConnector(
                url="snowflake://u:p@a/d",
                databases=["d"],
                connect_args={"session_parameters": {"QUERY_TAG": "team=data-eng"}},
            ),
        ],
        ids=[
            "snowflake_password",
            "snowflake_private_key",
            "snowflake_query_tag",
            "postgres_basic",
            "postgres_ssl",
            "postgres_application_name",
            "bigquery_basic",
            "bigquery_location",
            "bigquery_credentials",
            "bigquery_labels",
            "bigquery_location_and_labels",
            "sqlalchemy_sqlite",
            "sqlalchemy_postgres",
            "sqlalchemy_connect_args",
            "sqlalchemy_nested_connect_args",
        ],
    )
    def test_prelude_compiles(self, connector):
        prelude = connector.to_python_prelude()
        compile(prelude, "<string>", "exec")


class TestSQLiteEndToEnd:
    """Integration test using SQLite to verify generated code works."""

    def test_sqlite_execution(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "test.db"
            conn = SQLAlchemyConnector(
                url=f"sqlite:///{db_path}",
                databases=["test"],
            )
            conn.validate("test")

            prelude = conn.to_python_prelude()

            # Execute the prelude and test helpers
            local_vars: dict = {}
            exec(prelude, local_vars)

            # Create test table and data
            local_vars["_conn"].execute(
                local_vars["text"](
                    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"
                )
            )
            local_vars["_conn"].execute(
                local_vars["text"]("INSERT INTO users (name) VALUES ('Alice'), ('Bob')")
            )
            local_vars["_conn"].commit()

            # Test run_sql returns Polars
            result = local_vars["run_sql"]("SELECT * FROM users")
            assert len(result) == 2
            assert "polars" in str(type(result)).lower()

            # Test run_sql_pandas returns Pandas
            result_pd = local_vars["run_sql_pandas"]("SELECT * FROM users")
            assert len(result_pd) == 2
            assert "dataframe" in str(type(result_pd)).lower()
