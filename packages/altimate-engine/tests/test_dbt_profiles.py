"""Tests for dbt profiles.yml parser."""

import pytest


class TestParseProfilesYml:
    def test_basic_snowflake_profile(self, tmp_path):
        from altimate_engine.dbt.profiles import parse_profiles_yml

        profiles = {
            "my_project": {
                "target": "dev",
                "outputs": {
                    "dev": {
                        "type": "snowflake",
                        "account": "my_account",
                        "user": "my_user",
                        "password": "my_pass",
                        "warehouse": "COMPUTE_WH",
                        "database": "MY_DB",
                        "schema": "PUBLIC",
                    }
                },
            }
        }
        profiles_file = tmp_path / "profiles.yml"
        import yaml

        profiles_file.write_text(yaml.dump(profiles))

        result = parse_profiles_yml(str(profiles_file))
        assert "dbt_my_project_dev" in result
        conn = result["dbt_my_project_dev"]
        assert conn["type"] == "snowflake"
        assert conn["account"] == "my_account"

    def test_bigquery_keyfile_mapping(self, tmp_path):
        from altimate_engine.dbt.profiles import parse_profiles_yml

        profiles = {
            "bq_project": {
                "target": "prod",
                "outputs": {
                    "prod": {
                        "type": "bigquery",
                        "project": "my-gcp-project",
                        "keyfile": "/path/to/sa.json",
                        "location": "EU",
                    }
                },
            }
        }
        profiles_file = tmp_path / "profiles.yml"
        import yaml

        profiles_file.write_text(yaml.dump(profiles))

        result = parse_profiles_yml(str(profiles_file))
        conn = result["dbt_bq_project_prod"]
        assert conn["type"] == "bigquery"
        assert conn["credentials_path"] == "/path/to/sa.json"
        assert conn["location"] == "EU"

    def test_databricks_key_mapping(self, tmp_path):
        from altimate_engine.dbt.profiles import parse_profiles_yml

        profiles = {
            "db_project": {
                "target": "dev",
                "outputs": {
                    "dev": {
                        "type": "databricks",
                        "host": "workspace.cloud.databricks.com",
                        "http_path": "/sql/1.0/warehouses/abc",
                        "token": "dapi123",
                        "catalog": "main",
                        "schema": "default",
                    }
                },
            }
        }
        profiles_file = tmp_path / "profiles.yml"
        import yaml

        profiles_file.write_text(yaml.dump(profiles))

        result = parse_profiles_yml(str(profiles_file))
        conn = result["dbt_db_project_dev"]
        assert conn["type"] == "databricks"
        assert conn["server_hostname"] == "workspace.cloud.databricks.com"
        assert conn["access_token"] == "dapi123"

    def test_postgres_key_mapping(self, tmp_path):
        from altimate_engine.dbt.profiles import parse_profiles_yml

        profiles = {
            "pg_project": {
                "target": "dev",
                "outputs": {
                    "dev": {
                        "type": "postgres",
                        "host": "localhost",
                        "port": 5432,
                        "dbname": "my_db",
                        "user": "admin",
                        "password": "secret",
                    }
                },
            }
        }
        profiles_file = tmp_path / "profiles.yml"
        import yaml

        profiles_file.write_text(yaml.dump(profiles))

        result = parse_profiles_yml(str(profiles_file))
        conn = result["dbt_pg_project_dev"]
        assert conn["type"] == "postgres"
        assert conn["database"] == "my_db"
        assert conn["host"] == "localhost"

    def test_missing_file_returns_empty(self):
        from altimate_engine.dbt.profiles import parse_profiles_yml

        result = parse_profiles_yml("/nonexistent/profiles.yml")
        assert result == {}

    def test_malformed_yaml_returns_empty(self, tmp_path):
        from altimate_engine.dbt.profiles import parse_profiles_yml

        profiles_file = tmp_path / "profiles.yml"
        profiles_file.write_text("{{invalid yaml}}:")
        result = parse_profiles_yml(str(profiles_file))
        assert result == {}

    def test_unsupported_adapter_skipped(self, tmp_path):
        from altimate_engine.dbt.profiles import parse_profiles_yml

        profiles = {
            "weird": {
                "target": "dev",
                "outputs": {"dev": {"type": "oracle_special"}},
            }
        }
        profiles_file = tmp_path / "profiles.yml"
        import yaml

        profiles_file.write_text(yaml.dump(profiles))

        result = parse_profiles_yml(str(profiles_file))
        assert result == {}

    def test_multiple_profiles_and_outputs(self, tmp_path):
        from altimate_engine.dbt.profiles import parse_profiles_yml

        profiles = {
            "project_a": {
                "target": "dev",
                "outputs": {
                    "dev": {
                        "type": "postgres",
                        "host": "localhost",
                        "dbname": "dev_db",
                        "user": "u",
                        "password": "p",
                    },
                    "prod": {
                        "type": "postgres",
                        "host": "prod-host",
                        "dbname": "prod_db",
                        "user": "u",
                        "password": "p",
                    },
                },
            },
            "project_b": {
                "target": "dev",
                "outputs": {
                    "dev": {"type": "duckdb", "path": "/tmp/test.duckdb"},
                },
            },
        }
        profiles_file = tmp_path / "profiles.yml"
        import yaml

        profiles_file.write_text(yaml.dump(profiles))

        result = parse_profiles_yml(str(profiles_file))
        assert len(result) == 3
        assert "dbt_project_a_dev" in result
        assert "dbt_project_a_prod" in result
        assert "dbt_project_b_dev" in result

    def test_config_section_skipped(self, tmp_path):
        from altimate_engine.dbt.profiles import parse_profiles_yml

        profiles = {
            "config": {
                "send_anonymous_usage_stats": False,
            },
            "my_project": {
                "target": "dev",
                "outputs": {
                    "dev": {
                        "type": "duckdb",
                        "path": "/tmp/dev.duckdb",
                    }
                },
            },
        }
        profiles_file = tmp_path / "profiles.yml"
        import yaml

        profiles_file.write_text(yaml.dump(profiles))

        result = parse_profiles_yml(str(profiles_file))
        assert len(result) == 1
        assert "dbt_my_project_dev" in result

    def test_redshift_key_mapping(self, tmp_path):
        from altimate_engine.dbt.profiles import parse_profiles_yml

        profiles = {
            "rs_project": {
                "target": "dev",
                "outputs": {
                    "dev": {
                        "type": "redshift",
                        "host": "cluster.redshift.amazonaws.com",
                        "port": 5439,
                        "dbname": "analytics",
                        "user": "admin",
                        "password": "secret",
                    }
                },
            }
        }
        profiles_file = tmp_path / "profiles.yml"
        import yaml

        profiles_file.write_text(yaml.dump(profiles))

        result = parse_profiles_yml(str(profiles_file))
        conn = result["dbt_rs_project_dev"]
        assert conn["type"] == "redshift"
        assert conn["database"] == "analytics"


class TestDiscoverDbtConnections:
    def test_returns_empty_on_error(self):
        from altimate_engine.dbt.profiles import discover_dbt_connections

        result = discover_dbt_connections("/definitely/not/a/real/path.yml")
        assert result == {}

    def test_wraps_parse_profiles(self, tmp_path):
        from altimate_engine.dbt.profiles import discover_dbt_connections

        profiles = {
            "test_proj": {
                "target": "dev",
                "outputs": {
                    "dev": {
                        "type": "duckdb",
                        "path": "/tmp/test.duckdb",
                    }
                },
            }
        }
        profiles_file = tmp_path / "profiles.yml"
        import yaml

        profiles_file.write_text(yaml.dump(profiles))

        result = discover_dbt_connections(str(profiles_file))
        assert "dbt_test_proj_dev" in result
        assert result["dbt_test_proj_dev"]["type"] == "duckdb"
