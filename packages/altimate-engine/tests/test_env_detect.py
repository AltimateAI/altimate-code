"""Tests for environment variable based warehouse detection.

These tests validate the env-var-to-warehouse mapping logic used by the
project_scan tool. The canonical implementation is in TypeScript
(src/tool/project-scan.ts), but these tests document the expected behavior
and can validate a Python-side implementation if one is added later.
"""

from __future__ import annotations

import pytest


# --- Reference implementation (mirrors TypeScript detectEnvVars) ---

ENV_VAR_SIGNALS: dict[str, dict] = {
    "snowflake": {
        "signals": ["SNOWFLAKE_ACCOUNT"],
        "config_map": {
            "account": "SNOWFLAKE_ACCOUNT",
            "user": "SNOWFLAKE_USER",
            "password": "SNOWFLAKE_PASSWORD",
            "warehouse": "SNOWFLAKE_WAREHOUSE",
            "database": "SNOWFLAKE_DATABASE",
            "schema": "SNOWFLAKE_SCHEMA",
            "role": "SNOWFLAKE_ROLE",
        },
    },
    "bigquery": {
        "signals": ["GOOGLE_APPLICATION_CREDENTIALS", "BIGQUERY_PROJECT", "GCP_PROJECT"],
        "config_map": {
            "project": ["BIGQUERY_PROJECT", "GCP_PROJECT"],
            "credentials_path": "GOOGLE_APPLICATION_CREDENTIALS",
            "location": "BIGQUERY_LOCATION",
        },
    },
    "databricks": {
        "signals": ["DATABRICKS_HOST", "DATABRICKS_SERVER_HOSTNAME"],
        "config_map": {
            "server_hostname": ["DATABRICKS_HOST", "DATABRICKS_SERVER_HOSTNAME"],
            "http_path": "DATABRICKS_HTTP_PATH",
            "access_token": "DATABRICKS_TOKEN",
        },
    },
    "postgres": {
        "signals": ["PGHOST", "PGDATABASE"],
        "config_map": {
            "host": "PGHOST",
            "port": "PGPORT",
            "database": "PGDATABASE",
            "user": "PGUSER",
            "password": "PGPASSWORD",
            "connection_string": "DATABASE_URL",
        },
    },
    "mysql": {
        "signals": ["MYSQL_HOST", "MYSQL_DATABASE"],
        "config_map": {
            "host": "MYSQL_HOST",
            "port": "MYSQL_TCP_PORT",
            "database": "MYSQL_DATABASE",
            "user": "MYSQL_USER",
            "password": "MYSQL_PASSWORD",
        },
    },
    "redshift": {
        "signals": ["REDSHIFT_HOST"],
        "config_map": {
            "host": "REDSHIFT_HOST",
            "port": "REDSHIFT_PORT",
            "database": "REDSHIFT_DATABASE",
            "user": "REDSHIFT_USER",
            "password": "REDSHIFT_PASSWORD",
        },
    },
}


SENSITIVE_KEYS = {"password", "access_token", "connection_string", "private_key_path"}

DATABASE_URL_SCHEME_MAP: dict[str, str] = {
    "postgresql": "postgres",
    "postgres": "postgres",
    "mysql": "mysql",
    "mysql2": "mysql",
    "redshift": "redshift",
    "sqlite": "sqlite",
    "sqlite3": "sqlite",
}


def detect_env_connections(env: dict[str, str] | None = None) -> list[dict]:
    """Detect warehouse connections from environment variables.

    Mirrors the TypeScript detectEnvVars implementation. Sensitive values
    (password, access_token, connection_string) are redacted with "***".

    Args:
        env: Environment dict to scan. Defaults to os.environ.

    Returns:
        List of detected connection dicts with keys: name, type, source, signal, config
    """
    if env is None:
        env = dict(os.environ)

    results: list[dict] = []

    for wh_type, spec in ENV_VAR_SIGNALS.items():
        # Check if any signal env var is present
        triggered_signal = None
        for signal_var in spec["signals"]:
            if signal_var in env and env[signal_var]:
                triggered_signal = signal_var
                break

        if triggered_signal is None:
            continue

        # Build config from env vars, redacting sensitive fields
        config: dict[str, str] = {}
        for config_key, env_key in spec["config_map"].items():
            if isinstance(env_key, list):
                # First match wins
                for key in env_key:
                    if key in env and env[key]:
                        config[config_key] = "***" if config_key in SENSITIVE_KEYS else env[key]
                        break
            else:
                if env_key in env and env[env_key]:
                    config[config_key] = "***" if config_key in SENSITIVE_KEYS else env[env_key]

        results.append({
            "name": f"env_{wh_type}",
            "type": wh_type,
            "source": "env-var",
            "signal": triggered_signal,
            "config": config,
        })

    # DATABASE_URL scheme-based detection
    database_url = env.get("DATABASE_URL", "")
    if database_url and not any(r.get("signal") == "DATABASE_URL" for r in results):
        scheme = database_url.split("://")[0].lower() if "://" in database_url else ""
        db_type = DATABASE_URL_SCHEME_MAP.get(scheme, "postgres")
        # Only add if this type wasn't already detected from other env vars
        if not any(r["type"] == db_type for r in results):
            results.append({
                "name": f"env_{db_type}",
                "type": db_type,
                "source": "env-var",
                "signal": "DATABASE_URL",
                "config": {"connection_string": "***"},
            })

    return results


# --- Tests ---


class TestSnowflakeDetection:
    def test_detected_with_account(self):
        env = {"SNOWFLAKE_ACCOUNT": "myorg.us-east-1", "SNOWFLAKE_USER": "admin"}
        result = detect_env_connections(env)
        assert len(result) == 1
        assert result[0]["type"] == "snowflake"
        assert result[0]["signal"] == "SNOWFLAKE_ACCOUNT"
        assert result[0]["config"]["account"] == "myorg.us-east-1"
        assert result[0]["config"]["user"] == "admin"

    def test_full_config(self):
        env = {
            "SNOWFLAKE_ACCOUNT": "org.region",
            "SNOWFLAKE_USER": "user",
            "SNOWFLAKE_PASSWORD": "pass",
            "SNOWFLAKE_WAREHOUSE": "COMPUTE_WH",
            "SNOWFLAKE_DATABASE": "ANALYTICS",
            "SNOWFLAKE_SCHEMA": "PUBLIC",
            "SNOWFLAKE_ROLE": "SYSADMIN",
        }
        result = detect_env_connections(env)
        assert len(result) == 1
        assert len(result[0]["config"]) == 7
        # Password should be redacted
        assert result[0]["config"]["password"] == "***"
        # Non-sensitive values should be present
        assert result[0]["config"]["account"] == "org.region"

    def test_not_detected_without_account(self):
        env = {"SNOWFLAKE_USER": "admin", "SNOWFLAKE_PASSWORD": "pass"}
        result = detect_env_connections(env)
        snowflake = [r for r in result if r["type"] == "snowflake"]
        assert len(snowflake) == 0


class TestBigQueryDetection:
    def test_detected_with_credentials(self):
        env = {"GOOGLE_APPLICATION_CREDENTIALS": "/path/to/creds.json"}
        result = detect_env_connections(env)
        bq = [r for r in result if r["type"] == "bigquery"]
        assert len(bq) == 1
        assert bq[0]["config"]["credentials_path"] == "/path/to/creds.json"

    def test_detected_with_bigquery_project(self):
        env = {"BIGQUERY_PROJECT": "my-project-123"}
        result = detect_env_connections(env)
        bq = [r for r in result if r["type"] == "bigquery"]
        assert len(bq) == 1
        assert bq[0]["config"]["project"] == "my-project-123"

    def test_detected_with_gcp_project(self):
        env = {"GCP_PROJECT": "my-project"}
        result = detect_env_connections(env)
        bq = [r for r in result if r["type"] == "bigquery"]
        assert len(bq) == 1

    def test_bigquery_project_preferred_over_gcp_project(self):
        env = {
            "BIGQUERY_PROJECT": "bq-proj",
            "GCP_PROJECT": "gcp-proj",
            "GOOGLE_APPLICATION_CREDENTIALS": "/creds.json",
        }
        result = detect_env_connections(env)
        bq = [r for r in result if r["type"] == "bigquery"]
        assert bq[0]["config"]["project"] == "bq-proj"


class TestDatabricksDetection:
    def test_detected_with_host(self):
        env = {"DATABRICKS_HOST": "adb-123.azuredatabricks.net"}
        result = detect_env_connections(env)
        db = [r for r in result if r["type"] == "databricks"]
        assert len(db) == 1
        assert db[0]["config"]["server_hostname"] == "adb-123.azuredatabricks.net"

    def test_detected_with_server_hostname(self):
        env = {"DATABRICKS_SERVER_HOSTNAME": "dbc-abc.cloud.databricks.com"}
        result = detect_env_connections(env)
        db = [r for r in result if r["type"] == "databricks"]
        assert len(db) == 1

    def test_host_preferred_over_server_hostname(self):
        env = {"DATABRICKS_HOST": "host1", "DATABRICKS_SERVER_HOSTNAME": "host2"}
        result = detect_env_connections(env)
        db = [r for r in result if r["type"] == "databricks"]
        assert db[0]["config"]["server_hostname"] == "host1"


class TestPostgresDetection:
    def test_detected_with_pghost(self):
        env = {"PGHOST": "localhost", "PGDATABASE": "mydb"}
        result = detect_env_connections(env)
        pg = [r for r in result if r["type"] == "postgres"]
        assert len(pg) == 1
        assert pg[0]["config"]["host"] == "localhost"

    def test_detected_with_database_url_postgres_scheme(self):
        env = {"DATABASE_URL": "postgresql://user:pass@localhost:5432/mydb"}
        result = detect_env_connections(env)
        pg = [r for r in result if r["type"] == "postgres"]
        assert len(pg) == 1
        assert pg[0]["signal"] == "DATABASE_URL"
        assert pg[0]["config"]["connection_string"] == "***"

    def test_database_url_mysql_scheme(self):
        env = {"DATABASE_URL": "mysql://user:pass@localhost:3306/mydb"}
        result = detect_env_connections(env)
        my = [r for r in result if r["type"] == "mysql"]
        assert len(my) == 1
        assert my[0]["signal"] == "DATABASE_URL"

    def test_database_url_does_not_duplicate(self):
        env = {"PGHOST": "localhost", "DATABASE_URL": "postgresql://user:pass@host/db"}
        result = detect_env_connections(env)
        pg = [r for r in result if r["type"] == "postgres"]
        assert len(pg) == 1
        assert pg[0]["signal"] == "PGHOST"

    def test_detected_with_pgdatabase_only(self):
        env = {"PGDATABASE": "analytics"}
        result = detect_env_connections(env)
        pg = [r for r in result if r["type"] == "postgres"]
        assert len(pg) == 1


class TestMysqlDetection:
    def test_detected_with_host(self):
        env = {"MYSQL_HOST": "mysql.example.com", "MYSQL_DATABASE": "shop"}
        result = detect_env_connections(env)
        my = [r for r in result if r["type"] == "mysql"]
        assert len(my) == 1

    def test_not_detected_without_signals(self):
        env = {"MYSQL_USER": "root", "MYSQL_PASSWORD": "secret"}
        result = detect_env_connections(env)
        my = [r for r in result if r["type"] == "mysql"]
        assert len(my) == 0


class TestRedshiftDetection:
    def test_detected_with_host(self):
        env = {"REDSHIFT_HOST": "cluster.abc.us-east-1.redshift.amazonaws.com"}
        result = detect_env_connections(env)
        rs = [r for r in result if r["type"] == "redshift"]
        assert len(rs) == 1


class TestNoEnvVars:
    def test_empty_env(self):
        result = detect_env_connections({})
        assert result == []

    def test_unrelated_env_vars(self):
        env = {"HOME": "/home/user", "PATH": "/usr/bin", "EDITOR": "vim"}
        result = detect_env_connections(env)
        assert result == []

    def test_empty_signal_values_ignored(self):
        env = {"SNOWFLAKE_ACCOUNT": "", "PGHOST": ""}
        result = detect_env_connections(env)
        assert result == []


class TestMultipleDetections:
    def test_multiple_warehouses(self):
        env = {
            "SNOWFLAKE_ACCOUNT": "org.region",
            "PGHOST": "localhost",
            "DATABRICKS_HOST": "adb.net",
        }
        result = detect_env_connections(env)
        types = {r["type"] for r in result}
        assert "snowflake" in types
        assert "postgres" in types
        assert "databricks" in types
        assert len(result) == 3

    def test_all_warehouses_detected(self):
        env = {
            "SNOWFLAKE_ACCOUNT": "org",
            "GOOGLE_APPLICATION_CREDENTIALS": "/creds.json",
            "DATABRICKS_HOST": "host",
            "PGHOST": "localhost",
            "MYSQL_HOST": "mysql",
            "REDSHIFT_HOST": "redshift",
        }
        result = detect_env_connections(env)
        assert len(result) == 6


class TestConnectionNames:
    def test_name_format(self):
        env = {"SNOWFLAKE_ACCOUNT": "org"}
        result = detect_env_connections(env)
        assert result[0]["name"] == "env_snowflake"

    def test_source_is_env_var(self):
        env = {"PGHOST": "localhost"}
        result = detect_env_connections(env)
        assert result[0]["source"] == "env-var"


class TestPartialConfig:
    def test_only_populated_keys_in_config(self):
        env = {"SNOWFLAKE_ACCOUNT": "org"}
        result = detect_env_connections(env)
        # Only account should be in config, not user/password/etc
        assert "account" in result[0]["config"]
        assert "password" not in result[0]["config"]
        assert "user" not in result[0]["config"]
