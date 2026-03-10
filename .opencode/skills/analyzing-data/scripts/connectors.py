"""Database connector registry, base class, and all connector implementations."""

import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, NamedTuple


# --- Base class ---


@dataclass
class DatabaseConnector(ABC):
    """Base class for database connectors."""

    databases: list[str]

    @classmethod
    @abstractmethod
    def connector_type(cls) -> str:
        """Return type identifier (e.g., 'snowflake', 'postgres')."""

    @classmethod
    @abstractmethod
    def from_dict(cls, data: dict[str, Any]) -> "DatabaseConnector":
        """Create from config dict."""

    @abstractmethod
    def validate(self, name: str) -> None:
        """Validate config. Raise ValueError if invalid."""

    @abstractmethod
    def get_required_packages(self) -> list[str]:
        """Return pip packages needed."""

    @abstractmethod
    def get_env_vars_for_kernel(self) -> dict[str, str]:
        """Return env vars to inject into kernel."""

    @abstractmethod
    def to_python_prelude(self) -> str:
        """Generate Python code for connection + helpers."""


# --- Utilities ---


def substitute_env_vars(value: Any) -> tuple[Any, str | None]:
    """Substitute ${VAR_NAME} with environment variable value."""
    if not isinstance(value, str):
        return value, None
    match = re.match(r"^\$\{([^}]+)\}$", value)
    if match:
        env_var_name = match.group(1)
        env_value = os.environ.get(env_var_name)
        return (env_value if env_value else value), env_var_name
    return value, None


# --- Registry ---

_CONNECTOR_REGISTRY: dict[str, type[DatabaseConnector]] = {}


def register_connector(cls: type[DatabaseConnector]) -> type[DatabaseConnector]:
    _CONNECTOR_REGISTRY[cls.connector_type()] = cls
    return cls


def get_connector_class(connector_type: str) -> type[DatabaseConnector]:
    if connector_type not in _CONNECTOR_REGISTRY:
        available = ", ".join(sorted(_CONNECTOR_REGISTRY.keys()))
        raise ValueError(
            f"Unknown connector type: {connector_type!r}. Available: {available}"
        )
    return _CONNECTOR_REGISTRY[connector_type]


def create_connector(data: dict[str, Any]) -> DatabaseConnector:
    connector_type = data.get("type", "snowflake")
    cls = get_connector_class(connector_type)
    return cls.from_dict(data)


def list_connector_types() -> list[str]:
    return sorted(_CONNECTOR_REGISTRY.keys())


# --- Snowflake Connector ---


@register_connector
@dataclass
class SnowflakeConnector(DatabaseConnector):
    account: str = ""
    user: str = ""
    auth_type: str = "password"
    password: str = ""
    private_key_path: str = ""
    private_key_passphrase: str = ""
    private_key: str = ""
    warehouse: str = ""
    role: str = ""
    schema: str = ""
    databases: list[str] = field(default_factory=list)
    client_session_keep_alive: bool = False
    password_env_var: str | None = None
    private_key_env_var: str | None = None
    private_key_passphrase_env_var: str | None = None
    query_tag: str = ""

    @classmethod
    def connector_type(cls) -> str:
        return "snowflake"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SnowflakeConnector":
        account, _ = substitute_env_vars(data.get("account", ""))
        user, _ = substitute_env_vars(data.get("user", ""))
        password, pw_env = substitute_env_vars(data.get("password", ""))
        private_key, pk_env = substitute_env_vars(data.get("private_key", ""))
        passphrase, pp_env = substitute_env_vars(data.get("private_key_passphrase", ""))

        return cls(
            account=account,
            user=user,
            auth_type=data.get("auth_type", "password"),
            password=password,
            private_key_path=data.get("private_key_path", ""),
            private_key_passphrase=passphrase,
            private_key=private_key,
            warehouse=data.get("warehouse", ""),
            role=data.get("role", ""),
            schema=data.get("schema", ""),
            databases=data.get("databases", []),
            client_session_keep_alive=data.get("client_session_keep_alive", False),
            password_env_var=pw_env,
            private_key_env_var=pk_env,
            private_key_passphrase_env_var=pp_env,
            query_tag=data.get("query_tag", ""),
        )

    def validate(self, name: str) -> None:
        if not self.account or self.account.startswith("${"):
            raise ValueError(f"warehouse '{name}': account required")
        if not self.user or self.user.startswith("${"):
            raise ValueError(f"warehouse '{name}': user required")
        if self.auth_type == "password":
            if not self.password or self.password.startswith("${"):
                raise ValueError(f"warehouse '{name}': password required")
        elif self.auth_type == "private_key":
            if not self.private_key_path and not self.private_key:
                raise ValueError(f"warehouse '{name}': private_key required")
        if len(self.query_tag) > 2000:
            raise ValueError(
                f"warehouse '{name}': query_tag exceeds Snowflake's 2000 character limit"
            )

    def get_required_packages(self) -> list[str]:
        pkgs = ["snowflake-connector-python[pandas]"]
        if self.auth_type == "private_key":
            pkgs.append("cryptography")
        return pkgs

    def get_env_vars_for_kernel(self) -> dict[str, str]:
        env_vars = {}
        if self.password_env_var and self.password:
            env_vars[self.password_env_var] = self.password
        if self.private_key_env_var and self.private_key:
            env_vars[self.private_key_env_var] = self.private_key
        if self.private_key_passphrase_env_var and self.private_key_passphrase:
            env_vars[self.private_key_passphrase_env_var] = self.private_key_passphrase
        return env_vars

    def to_python_prelude(self) -> str:
        from templates import (
            HELPERS_CODE,
            PRIVATE_KEY_CONTENT_TEMPLATE,
            PRIVATE_KEY_FILE_TEMPLATE,
        )

        sections = []

        # Imports
        sections.append("""import snowflake.connector
import polars as pl
import pandas as pd
import os""")

        # Private key loader (if needed)
        if self.auth_type == "private_key":
            if self.private_key_passphrase_env_var:
                passphrase_code = f"os.environ.get({self.private_key_passphrase_env_var!r}, '').encode() or None"
            elif self.private_key_passphrase:
                passphrase_code = f"{self.private_key_passphrase!r}.encode()"
            else:
                passphrase_code = "None"

            if self.private_key_path:
                sections.append(
                    PRIVATE_KEY_FILE_TEMPLATE.substitute(
                        KEY_PATH=repr(self.private_key_path),
                        PASSPHRASE_CODE=passphrase_code,
                    )
                )
            else:
                key_code = (
                    f"os.environ.get({self.private_key_env_var!r})"
                    if self.private_key_env_var
                    else repr(self.private_key)
                )
                sections.append(
                    PRIVATE_KEY_CONTENT_TEMPLATE.substitute(
                        KEY_CODE=key_code,
                        PASSPHRASE_CODE=passphrase_code,
                    )
                )

        # Connection
        lines = ["_conn = snowflake.connector.connect("]
        lines.append(f"    account={self.account!r},")
        lines.append(f"    user={self.user!r},")
        if self.auth_type == "password":
            if self.password_env_var:
                lines.append(f"    password=os.environ.get({self.password_env_var!r}),")
            else:
                lines.append(f"    password={self.password!r},")
        elif self.auth_type == "private_key":
            lines.append("    private_key=_load_private_key(),")
        if self.warehouse:
            lines.append(f"    warehouse={self.warehouse!r},")
        if self.role:
            lines.append(f"    role={self.role!r},")
        if self.databases:
            lines.append(f"    database={self.databases[0]!r},")
        if self.query_tag:
            lines.append(f"    session_parameters={{'QUERY_TAG': {self.query_tag!r}}},")
        lines.append(f"    client_session_keep_alive={self.client_session_keep_alive},")
        lines.append(")")
        sections.append("\n".join(lines))

        # Helper functions
        helpers_code = HELPERS_CODE
        if "def " in helpers_code:
            helpers_code = "def " + helpers_code.split("def ", 1)[1]
        sections.append(helpers_code.strip())

        # Status output
        status_lines = [
            'print("Snowflake connection established")',
            'print(f"   Account: {_conn.account}")',
            'print(f"   User: {_conn.user}")',
        ]
        if self.warehouse:
            status_lines.append(f'print(f"   Warehouse: {self.warehouse}")')
        if self.role:
            status_lines.append(f'print(f"   Role: {self.role}")')
        if self.databases:
            status_lines.append(f'print(f"   Database: {self.databases[0]}")')
        if self.query_tag:
            status_lines.append(f'print(f"   Query Tag: {self.query_tag}")')
        status_lines.append(
            'print("\\nAvailable: run_sql(query) -> polars, run_sql_pandas(query) -> pandas")'
        )
        sections.append("\n".join(status_lines))

        return "\n\n".join(sections)


# --- PostgreSQL Connector ---


@register_connector
@dataclass
class PostgresConnector(DatabaseConnector):
    host: str = ""
    port: int = 5432
    user: str = ""
    password: str = ""
    database: str = ""
    sslmode: str = ""
    databases: list[str] = field(default_factory=list)
    password_env_var: str | None = None
    application_name: str = ""

    @classmethod
    def connector_type(cls) -> str:
        return "postgres"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PostgresConnector":
        host, _ = substitute_env_vars(data.get("host", ""))
        user, _ = substitute_env_vars(data.get("user", ""))
        password, pw_env = substitute_env_vars(data.get("password", ""))
        database, _ = substitute_env_vars(data.get("database", ""))

        return cls(
            host=host,
            port=data.get("port", 5432),
            user=user,
            password=password,
            database=database,
            sslmode=data.get("sslmode", ""),
            databases=data.get("databases", [database] if database else []),
            password_env_var=pw_env,
            application_name=data.get("application_name", ""),
        )

    def validate(self, name: str) -> None:
        if not self.host or self.host.startswith("${"):
            raise ValueError(f"warehouse '{name}': host required for postgres")
        if not self.user or self.user.startswith("${"):
            raise ValueError(f"warehouse '{name}': user required for postgres")
        if not self.database or self.database.startswith("${"):
            raise ValueError(f"warehouse '{name}': database required for postgres")

    def get_required_packages(self) -> list[str]:
        return ["psycopg[binary,pool]"]

    def get_env_vars_for_kernel(self) -> dict[str, str]:
        env_vars = {}
        if self.password_env_var and self.password:
            env_vars[self.password_env_var] = self.password
        return env_vars

    def to_python_prelude(self) -> str:
        lines = ["_conn = psycopg.connect("]
        lines.append(f"    host={self.host!r},")
        lines.append(f"    port={self.port},")
        lines.append(f"    user={self.user!r},")
        if self.password_env_var:
            lines.append(f"    password=os.environ.get({self.password_env_var!r}),")
        elif self.password:
            lines.append(f"    password={self.password!r},")
        lines.append(f"    dbname={self.database!r},")
        if self.sslmode:
            lines.append(f"    sslmode={self.sslmode!r},")
        if self.application_name:
            lines.append(f"    application_name={self.application_name!r},")
        lines.append("    autocommit=True,")
        lines.append(")")
        connection_code = "\n".join(lines)

        status_lines = [
            'print("PostgreSQL connection established")',
            f'print("   Host: {self.host}:{self.port}")',
            f'print("   User: {self.user}")',
            f'print("   Database: {self.database}")',
        ]
        if self.application_name:
            status_lines.append(f'print("   Application: {self.application_name}")')
        status_lines += [
            'print("\\nAvailable: run_sql(query) -> polars, run_sql_pandas(query) -> pandas")',
        ]
        status_code = "\n".join(status_lines)

        return f'''import psycopg
import polars as pl
import pandas as pd
import os

{connection_code}

def run_sql(query: str, limit: int = 100):
    """Execute SQL and return Polars DataFrame."""
    with _conn.cursor() as cursor:
        cursor.execute(query)
        if cursor.description is None:
            return pl.DataFrame()
        columns = [desc[0] for desc in cursor.description]
        rows = cursor.fetchall()
        result = pl.DataFrame(rows, schema=columns, orient="row")
        return result.head(limit) if limit > 0 and len(result) > limit else result


def run_sql_pandas(query: str, limit: int = 100):
    """Execute SQL and return Pandas DataFrame."""
    with _conn.cursor() as cursor:
        cursor.execute(query)
        if cursor.description is None:
            return pd.DataFrame()
        columns = [desc[0] for desc in cursor.description]
        rows = cursor.fetchall()
        df = pd.DataFrame(rows, columns=columns)
        return df.head(limit) if limit > 0 and len(df) > limit else df

{status_code}'''


# --- BigQuery Connector ---

# Google allows international characters in BQ labels, but we restrict to ASCII
# for simplicity. Expand the regex if international support is needed.
_BQ_LABEL_KEY_RE = re.compile(r"^[a-z][a-z0-9_-]{0,62}$")
_BQ_LABEL_VALUE_RE = re.compile(r"^[a-z0-9_-]{0,63}$")


@register_connector
@dataclass
class BigQueryConnector(DatabaseConnector):
    project: str = ""
    credentials_path: str = ""
    location: str = ""
    databases: list[str] = field(default_factory=list)
    labels: dict[str, str] = field(default_factory=dict)

    @classmethod
    def connector_type(cls) -> str:
        return "bigquery"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BigQueryConnector":
        project, _ = substitute_env_vars(data.get("project", ""))
        credentials_path, _ = substitute_env_vars(data.get("credentials_path", ""))

        return cls(
            project=project,
            credentials_path=credentials_path,
            location=data.get("location", ""),
            databases=data.get("databases", [project] if project else []),
            labels=data.get("labels", {}),
        )

    def validate(self, name: str) -> None:
        if not self.project or self.project.startswith("${"):
            raise ValueError(f"warehouse '{name}': project required for bigquery")
        if len(self.labels) > 64:
            raise ValueError(
                f"warehouse '{name}': BigQuery supports at most 64 labels, got {len(self.labels)}"
            )
        for k, v in self.labels.items():
            if not isinstance(k, str) or not _BQ_LABEL_KEY_RE.match(k):
                raise ValueError(
                    f"warehouse '{name}': invalid BigQuery label key {k!r} "
                    "(must match [a-z][a-z0-9_-]{0,62})"
                )
            if not isinstance(v, str):
                raise ValueError(
                    f"warehouse '{name}': label value for {k!r} must be a string, got {type(v).__name__}"
                )
            if not _BQ_LABEL_VALUE_RE.match(v):
                raise ValueError(
                    f"warehouse '{name}': invalid BigQuery label value {v!r} for key {k!r} "
                    "(must match [a-z0-9_-]{0,63})"
                )

    def get_required_packages(self) -> list[str]:
        return ["google-cloud-bigquery[pandas,pyarrow]", "db-dtypes"]

    def get_env_vars_for_kernel(self) -> dict[str, str]:
        env_vars = {}
        if self.credentials_path:
            env_vars["GOOGLE_APPLICATION_CREDENTIALS"] = self.credentials_path
        return env_vars

    def to_python_prelude(self) -> str:
        if self.credentials_path:
            conn_code = f"""from google.oauth2 import service_account
_credentials = service_account.Credentials.from_service_account_file({self.credentials_path!r})
_client = bigquery.Client(project={self.project!r}, credentials=_credentials)"""
        else:
            conn_code = f"_client = bigquery.Client(project={self.project!r})"

        # Build QueryJobConfig arguments
        job_config_args = []
        if self.labels:
            job_config_args.append(f"labels={self.labels!r}")
        job_config_str = ", ".join(job_config_args)

        # Build _client.query() extra kwargs
        query_extra_args = ""
        if self.location:
            query_extra_args = f", location={self.location!r}"

        auth_type = (
            "Service Account"
            if self.credentials_path
            else "Application Default Credentials"
        )

        status_lines = [
            'print("BigQuery client initialized")',
            f'print(f"   Project: {self.project}")',
        ]
        if self.location:
            status_lines.append(f'print(f"   Location: {self.location}")')
        status_lines.append(f'print("   Auth: {auth_type}")')
        if self.labels:
            status_lines.append(f'print(f"   Labels: {self.labels!r}")')
        status_lines.append(
            'print("\\nAvailable: run_sql(query) -> polars, run_sql_pandas(query) -> pandas")'
        )
        status_code = "\n".join(status_lines)

        return f'''from google.cloud import bigquery
import polars as pl
import pandas as pd
import os

{conn_code}

def run_sql(query: str, limit: int = 100):
    """Execute SQL and return Polars DataFrame."""
    job_config = bigquery.QueryJobConfig({job_config_str})
    query_job = _client.query(query, job_config=job_config{query_extra_args})
    df = query_job.to_dataframe()
    result = pl.from_pandas(df)
    return result.head(limit) if limit > 0 and len(result) > limit else result


def run_sql_pandas(query: str, limit: int = 100):
    """Execute SQL and return Pandas DataFrame."""
    job_config = bigquery.QueryJobConfig({job_config_str})
    query_job = _client.query(query, job_config=job_config{query_extra_args})
    df = query_job.to_dataframe()
    return df.head(limit) if limit > 0 and len(df) > limit else df

{status_code}'''


# --- SQLAlchemy Connector ---


class DialectInfo(NamedTuple):
    """Database dialect configuration.

    To add a new database:
    1. Add an entry to DIALECTS below with (display_name, [packages])
    2. Run tests: uv run pytest tests/test_connectors.py -v
    """

    display_name: str
    packages: list[str]


# Mapping of dialect/driver names to their configuration.
# The dialect is extracted from URLs like "dialect+driver://..." or "dialect://..."
# When a driver is specified (e.g., mysql+pymysql), the driver name is looked up first.
DIALECTS: dict[str, DialectInfo] = {
    # PostgreSQL variants
    "postgresql": DialectInfo("PostgreSQL", ["psycopg[binary]"]),
    "postgres": DialectInfo("PostgreSQL", ["psycopg[binary]"]),
    "psycopg": DialectInfo("PostgreSQL", ["psycopg[binary]"]),
    "psycopg2": DialectInfo("PostgreSQL", ["psycopg2-binary"]),
    "pg8000": DialectInfo("PostgreSQL", ["pg8000"]),
    "asyncpg": DialectInfo("PostgreSQL", ["asyncpg"]),
    # MySQL variants
    "mysql": DialectInfo("MySQL", ["pymysql"]),
    "pymysql": DialectInfo("MySQL", ["pymysql"]),
    "mysqlconnector": DialectInfo("MySQL", ["mysql-connector-python"]),
    "mysqldb": DialectInfo("MySQL", ["mysqlclient"]),
    "mariadb": DialectInfo("MariaDB", ["mariadb"]),
    # SQLite (built-in, no extra packages)
    "sqlite": DialectInfo("SQLite", []),
    # Oracle
    "oracle": DialectInfo("Oracle", ["oracledb"]),
    "oracledb": DialectInfo("Oracle", ["oracledb"]),
    # SQL Server
    "mssql": DialectInfo("SQL Server", ["pyodbc"]),
    "pyodbc": DialectInfo("SQL Server", ["pyodbc"]),
    "pymssql": DialectInfo("SQL Server", ["pymssql"]),
    # Cloud data warehouses
    "redshift": DialectInfo("Redshift", ["redshift_connector"]),
    "redshift_connector": DialectInfo("Redshift", ["redshift_connector"]),
    "snowflake": DialectInfo(
        "Snowflake", ["snowflake-sqlalchemy", "snowflake-connector-python"]
    ),
    "bigquery": DialectInfo("BigQuery", ["sqlalchemy-bigquery"]),
    # DuckDB
    "duckdb": DialectInfo("DuckDB", ["duckdb", "duckdb-engine"]),
    # Other databases
    "trino": DialectInfo("Trino", ["trino"]),
    "clickhouse": DialectInfo(
        "ClickHouse", ["clickhouse-driver", "clickhouse-sqlalchemy"]
    ),
    "cockroachdb": DialectInfo(
        "CockroachDB", ["sqlalchemy-cockroachdb", "psycopg[binary]"]
    ),
    "databricks": DialectInfo("Databricks", ["databricks-sql-connector"]),
    "teradata": DialectInfo("Teradata", ["teradatasqlalchemy"]),
    "vertica": DialectInfo("Vertica", ["vertica-python"]),
    "hana": DialectInfo("SAP HANA", ["hdbcli"]),
    "db2": DialectInfo("IBM Db2", ["ibm_db_sa"]),
    "firebird": DialectInfo("Firebird", ["fdb"]),
    "awsathena": DialectInfo("Amazon Athena", ["pyathena"]),
    "spanner": DialectInfo("Cloud Spanner", ["sqlalchemy-spanner"]),
}


def _extract_dialect(url: str) -> str | None:
    """Extract dialect name from SQLAlchemy URL.

    URLs can be:
    - dialect://user:pass@host/db
    - dialect+driver://user:pass@host/db

    When a driver is specified, returns the driver name (looked up first in DIALECTS).
    Falls back to dialect name if driver isn't in DIALECTS.
    """
    match = re.match(r"^([a-zA-Z0-9_-]+)(?:\+([a-zA-Z0-9_-]+))?://", url)
    if match:
        dialect = match.group(1).lower()
        driver = match.group(2).lower() if match.group(2) else None
        # Prefer driver if specified AND it's in our dialects mapping
        # Otherwise fall back to dialect (e.g., postgresql+asyncpg -> asyncpg if known)
        if driver and driver in DIALECTS:
            return driver
        return dialect
    return None


@register_connector
@dataclass
class SQLAlchemyConnector(DatabaseConnector):
    url: str = ""
    databases: list[str] = field(default_factory=list)
    pool_size: int = 5
    echo: bool = False
    url_env_var: str | None = None
    connect_args: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def connector_type(cls) -> str:
        return "sqlalchemy"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SQLAlchemyConnector":
        url, url_env = substitute_env_vars(data.get("url", ""))

        return cls(
            url=url,
            databases=data.get("databases", []),
            pool_size=data.get("pool_size", 5),
            echo=data.get("echo", False),
            url_env_var=url_env,
            connect_args=data.get("connect_args", {}),
        )

    def validate(self, name: str) -> None:
        if not self.url or self.url.startswith("${"):
            raise ValueError(f"warehouse '{name}': url required for sqlalchemy")
        if not self.databases:
            raise ValueError(
                f"warehouse '{name}': databases list required for sqlalchemy"
            )

    def get_required_packages(self) -> list[str]:
        packages = ["sqlalchemy"]
        dialect = _extract_dialect(self.url)
        if dialect and dialect in DIALECTS:
            packages.extend(DIALECTS[dialect].packages)
        return packages

    def get_env_vars_for_kernel(self) -> dict[str, str]:
        env_vars = {}
        if self.url_env_var and self.url:
            env_vars[self.url_env_var] = self.url
        return env_vars

    def to_python_prelude(self) -> str:
        if self.url_env_var:
            url_code = f"os.environ.get({self.url_env_var!r})"
        else:
            url_code = repr(self.url)

        # Infer DB type for status message
        dialect = _extract_dialect(self.url)
        db_type = (
            DIALECTS[dialect].display_name
            if dialect and dialect in DIALECTS
            else "Database"
        )

        databases_str = ", ".join(self.databases)

        return f'''from sqlalchemy import create_engine, text
import polars as pl
import pandas as pd
import os
import atexit

_engine = create_engine({url_code}, pool_size={self.pool_size}, echo={self.echo}{f", connect_args={self.connect_args!r}" if self.connect_args else ""})
_conn = _engine.connect()
atexit.register(lambda: (_conn.close(), _engine.dispose()))

def run_sql(query: str, limit: int = 100):
    """Execute SQL and return Polars DataFrame."""
    result = _conn.execute(text(query))
    if result.returns_rows:
        columns = list(result.keys())
        rows = result.fetchall()
        df = pl.DataFrame(rows, schema=columns, orient="row")
        return df.head(limit) if limit > 0 and len(df) > limit else df
    return pl.DataFrame()


def run_sql_pandas(query: str, limit: int = 100):
    """Execute SQL and return Pandas DataFrame."""
    result = _conn.execute(text(query))
    if result.returns_rows:
        columns = list(result.keys())
        rows = result.fetchall()
        df = pd.DataFrame(rows, columns=columns)
        return df.head(limit) if limit > 0 and len(df) > limit else df
    return pd.DataFrame()

print("{db_type} connection established (via SQLAlchemy)")
print(f"   Database(s): {databases_str}")
print("\\nAvailable: run_sql(query) -> polars, run_sql_pandas(query) -> pandas")'''


__all__ = [
    "DatabaseConnector",
    "substitute_env_vars",
    "register_connector",
    "get_connector_class",
    "create_connector",
    "list_connector_types",
    "SnowflakeConnector",
    "PostgresConnector",
    "BigQueryConnector",
    "SQLAlchemyConnector",
    "DialectInfo",
    "DIALECTS",
]
