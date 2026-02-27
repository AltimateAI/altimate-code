"""Tests for enterprise connectors -- Redshift, MySQL, SQL Server."""

from unittest.mock import patch, MagicMock

import pytest

from altimate_engine.connections import ConnectionRegistry


@pytest.fixture(autouse=True)
def reset_registry():
    ConnectionRegistry._connections = {}
    ConnectionRegistry._loaded = False
    yield
    ConnectionRegistry._connections = {}
    ConnectionRegistry._loaded = False


class TestRedshiftConnector:
    def test_instantiation(self):
        from altimate_engine.connectors.redshift import RedshiftConnector

        conn = RedshiftConnector(
            host="my-cluster.us-east-1.redshift.amazonaws.com",
            port=5439,
            database="dev",
            user="admin",
            password="secret",
        )
        assert conn.host == "my-cluster.us-east-1.redshift.amazonaws.com"
        assert conn.port == 5439
        assert conn.database == "dev"

    def test_inherits_postgres(self):
        from altimate_engine.connectors.redshift import RedshiftConnector
        from altimate_engine.connectors.postgres import PostgresConnector

        assert issubclass(RedshiftConnector, PostgresConnector)

    def test_iam_role_requires_cluster_id(self):
        from altimate_engine.connectors.redshift import RedshiftConnector

        conn = RedshiftConnector(
            host="my-cluster.us-east-1.redshift.amazonaws.com",
            user="admin",
            iam_role="arn:aws:iam::role/RedshiftAccess",
        )
        with pytest.raises(ValueError, match="cluster_identifier"):
            conn._resolve_iam_credentials()

    def test_default_port(self):
        from altimate_engine.connectors.redshift import RedshiftConnector

        conn = RedshiftConnector()
        assert conn.port == 5439

    def test_default_database(self):
        from altimate_engine.connectors.redshift import RedshiftConnector

        conn = RedshiftConnector()
        assert conn.database == "dev"

    def test_registry_get_redshift(self):
        ConnectionRegistry._connections = {
            "rs": {
                "type": "redshift",
                "host": "cluster.redshift.amazonaws.com",
                "user": "admin",
                "password": "secret",
            }
        }
        ConnectionRegistry._loaded = True
        from altimate_engine.connectors.redshift import RedshiftConnector

        connector = ConnectionRegistry.get("rs")
        assert isinstance(connector, RedshiftConnector)


class TestMySQLConnector:
    def test_instantiation(self):
        from altimate_engine.connectors.mysql import MySQLConnector

        conn = MySQLConnector(
            host="localhost",
            port=3306,
            database="mydb",
            user="root",
            password="secret",
        )
        assert conn.host == "localhost"
        assert conn.port == 3306
        assert conn.database == "mydb"

    def test_default_host_and_port(self):
        from altimate_engine.connectors.mysql import MySQLConnector

        conn = MySQLConnector()
        assert conn.host == "localhost"
        assert conn.port == 3306

    def test_ssl_params(self):
        from altimate_engine.connectors.mysql import MySQLConnector

        conn = MySQLConnector(
            ssl_ca="/path/to/ca.pem",
            ssl_cert="/path/to/cert.pem",
            ssl_key="/path/to/key.pem",
        )
        assert conn.ssl_ca == "/path/to/ca.pem"
        assert conn.ssl_cert == "/path/to/cert.pem"
        assert conn.ssl_key == "/path/to/key.pem"

    def test_registry_get_mysql(self):
        ConnectionRegistry._connections = {
            "my": {
                "type": "mysql",
                "host": "localhost",
                "user": "root",
                "password": "secret",
            }
        }
        ConnectionRegistry._loaded = True
        from altimate_engine.connectors.mysql import MySQLConnector

        connector = ConnectionRegistry.get("my")
        assert isinstance(connector, MySQLConnector)


class TestSQLServerConnector:
    def test_instantiation(self):
        from altimate_engine.connectors.sqlserver import SQLServerConnector

        conn = SQLServerConnector(
            host="localhost",
            port=1433,
            database="master",
            user="sa",
            password="secret",
        )
        assert conn.host == "localhost"
        assert conn.port == 1433
        assert conn.database == "master"

    def test_default_driver(self):
        from altimate_engine.connectors.sqlserver import SQLServerConnector

        conn = SQLServerConnector()
        assert conn.driver == "ODBC Driver 18 for SQL Server"

    def test_default_port(self):
        from altimate_engine.connectors.sqlserver import SQLServerConnector

        conn = SQLServerConnector()
        assert conn.port == 1433

    def test_azure_auth_flag(self):
        from altimate_engine.connectors.sqlserver import SQLServerConnector

        conn = SQLServerConnector(azure_auth=True)
        assert conn.azure_auth is True

    def test_trust_server_certificate_flag(self):
        from altimate_engine.connectors.sqlserver import SQLServerConnector

        conn = SQLServerConnector(trust_server_certificate=True)
        assert conn.trust_server_certificate is True

    def test_registry_get_sqlserver(self):
        ConnectionRegistry._connections = {
            "mssql": {
                "type": "sqlserver",
                "host": "localhost",
                "user": "sa",
                "password": "secret",
            }
        }
        ConnectionRegistry._loaded = True
        from altimate_engine.connectors.sqlserver import SQLServerConnector

        connector = ConnectionRegistry.get("mssql")
        assert isinstance(connector, SQLServerConnector)
