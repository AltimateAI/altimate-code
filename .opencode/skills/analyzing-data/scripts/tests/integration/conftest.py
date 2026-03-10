"""Fixtures for integration tests."""

import os
import tempfile

import pytest


@pytest.fixture
def postgres_config():
    """PostgreSQL connection config from environment or skip."""
    host = os.environ.get("TEST_POSTGRES_HOST", "localhost")
    port = os.environ.get("TEST_POSTGRES_PORT", "5432")
    user = os.environ.get("TEST_POSTGRES_USER", "test")
    password = os.environ.get("TEST_POSTGRES_PASSWORD", "test")
    database = os.environ.get("TEST_POSTGRES_DB", "testdb")

    # Check if we can connect
    try:
        import psycopg

        conn = psycopg.connect(
            host=host,
            port=int(port),
            user=user,
            password=password,
            dbname=database,
            connect_timeout=5,
        )
        conn.close()
    except Exception as e:
        pytest.skip(f"PostgreSQL not available: {e}")

    return {
        "host": host,
        "port": int(port),
        "user": user,
        "password": password,
        "database": database,
    }


@pytest.fixture
def duckdb_path():
    """Temporary DuckDB database file."""
    try:
        import duckdb  # noqa: F401
    except ImportError:
        pytest.skip("duckdb not installed")

    with tempfile.TemporaryDirectory() as tmpdir:
        yield f"{tmpdir}/test.duckdb"


@pytest.fixture
def sqlite_path():
    """Temporary SQLite database file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield f"{tmpdir}/test.db"
