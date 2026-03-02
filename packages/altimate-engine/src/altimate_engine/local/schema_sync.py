"""Sync remote warehouse schema to local DuckDB for offline testing."""

from __future__ import annotations

from typing import Any

from altimate_engine.connections import ConnectionRegistry


def sync_schema(
    warehouse: str,
    target_path: str = ":memory:",
    schemas: list[str] | None = None,
    sample_rows: int = 0,
    limit: int | None = None,
) -> dict[str, Any]:
    """Sync remote warehouse schema to a local DuckDB database.

    Creates empty stub tables matching the remote schema structure.
    Optionally samples N rows per table for realistic testing.

    Args:
        warehouse: Connection name from registry (remote warehouse).
        target_path: Path to local DuckDB file, or ":memory:" for in-memory.
        schemas: List of schemas to sync. If None, syncs all schemas.
        sample_rows: Number of rows to sample per table. 0 = schema only.
        limit: Maximum number of tables to sync. None = no limit.

    Returns:
        Dict with sync results: tables_synced, columns_synced, errors, etc.
    """
    try:
        remote = ConnectionRegistry.get(warehouse)
    except ValueError:
        return {
            "success": False,
            "error": f"Connection '{warehouse}' not found.",
            "tables_synced": 0,
            "columns_synced": 0,
        }

    try:
        from altimate_engine.connectors.duckdb import DuckDBConnector
    except ImportError:
        return {
            "success": False,
            "error": "duckdb not installed. Install with: pip install duckdb",
            "tables_synced": 0,
            "columns_synced": 0,
        }

    local = DuckDBConnector(path=target_path)

    try:
        remote.connect()
        local.connect()

        # Create metadata schema
        local.execute("CREATE SCHEMA IF NOT EXISTS _altimate_meta")

        # Get schemas to sync
        if schemas:
            target_schemas = schemas
        else:
            target_schemas = remote.list_schemas()

        tables_synced = 0
        columns_synced = 0
        errors: list[str] = []
        table_count = 0

        for schema_name in target_schemas:
            try:
                local.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema_name}"')
            except Exception as e:
                errors.append(f"Failed to create schema {schema_name}: {e}")
                continue

            try:
                tables = remote.list_tables(schema_name)
            except Exception as e:
                errors.append(f"Failed to list tables in {schema_name}: {e}")
                continue

            for table_info in tables:
                if limit is not None and table_count >= limit:
                    break

                table_name = table_info["name"]
                try:
                    columns = remote.describe_table(schema_name, table_name)
                except Exception as e:
                    errors.append(f"Failed to describe {schema_name}.{table_name}: {e}")
                    continue

                if not columns:
                    continue

                # Build CREATE TABLE statement
                col_defs = []
                for col in columns:
                    duckdb_type = _map_type(col.get("data_type", "VARCHAR"))
                    nullable = "" if col.get("nullable", True) else " NOT NULL"
                    col_defs.append(f'"{col["name"]}" {duckdb_type}{nullable}')

                create_sql = (
                    f'CREATE TABLE IF NOT EXISTS "{schema_name}"."{table_name}" '
                    f'({", ".join(col_defs)})'
                )

                try:
                    local.execute(create_sql)
                    tables_synced += 1
                    columns_synced += len(columns)
                    table_count += 1
                except Exception as e:
                    errors.append(f"Failed to create {schema_name}.{table_name}: {e}")
                    continue

                # Sample rows if requested
                if sample_rows > 0:
                    try:
                        sample = remote.execute(
                            f'SELECT * FROM "{schema_name}"."{table_name}"',
                            limit=sample_rows,
                        )
                        if sample:
                            _insert_sample_rows(local, schema_name, table_name, sample, columns)
                    except Exception as e:
                        errors.append(f"Failed to sample {schema_name}.{table_name}: {e}")

            if limit is not None and table_count >= limit:
                break

        # Record sync metadata
        local.execute(
            "CREATE TABLE IF NOT EXISTS _altimate_meta.sync_log ("
            "warehouse VARCHAR, synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "
            "tables_synced INTEGER, columns_synced INTEGER)"
        )
        local.execute(
            f"INSERT INTO _altimate_meta.sync_log (warehouse, tables_synced, columns_synced) "
            f"VALUES ('{warehouse}', {tables_synced}, {columns_synced})"
        )

        return {
            "success": True,
            "warehouse": warehouse,
            "target_path": target_path,
            "tables_synced": tables_synced,
            "columns_synced": columns_synced,
            "schemas_synced": len(target_schemas),
            "errors": errors if errors else None,
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "tables_synced": 0,
            "columns_synced": 0,
        }
    finally:
        remote.close()
        local.close()


def _map_type(remote_type: str) -> str:
    """Map a remote column type to a DuckDB-compatible type."""
    rt = remote_type.upper().split("(")[0].strip()
    mapping = {
        "INT": "INTEGER",
        "INT4": "INTEGER",
        "INT8": "BIGINT",
        "BIGINT": "BIGINT",
        "SMALLINT": "SMALLINT",
        "TINYINT": "TINYINT",
        "INTEGER": "INTEGER",
        "FLOAT": "FLOAT",
        "FLOAT4": "FLOAT",
        "FLOAT8": "DOUBLE",
        "DOUBLE": "DOUBLE",
        "REAL": "FLOAT",
        "DECIMAL": "DECIMAL",
        "NUMERIC": "DECIMAL",
        "NUMBER": "DECIMAL",
        "BOOLEAN": "BOOLEAN",
        "BOOL": "BOOLEAN",
        "VARCHAR": "VARCHAR",
        "CHAR": "VARCHAR",
        "TEXT": "VARCHAR",
        "STRING": "VARCHAR",
        "NVARCHAR": "VARCHAR",
        "NCHAR": "VARCHAR",
        "DATE": "DATE",
        "DATETIME": "TIMESTAMP",
        "TIMESTAMP": "TIMESTAMP",
        "TIMESTAMP_NTZ": "TIMESTAMP",
        "TIMESTAMP_LTZ": "TIMESTAMPTZ",
        "TIMESTAMP_TZ": "TIMESTAMPTZ",
        "TIMESTAMPTZ": "TIMESTAMPTZ",
        "TIME": "TIME",
        "BINARY": "BLOB",
        "VARBINARY": "BLOB",
        "BLOB": "BLOB",
        "BYTES": "BLOB",
        "VARIANT": "JSON",
        "OBJECT": "JSON",
        "ARRAY": "JSON",
        "JSON": "JSON",
        "STRUCT": "JSON",
        "MAP": "JSON",
        "GEOGRAPHY": "VARCHAR",
        "GEOMETRY": "VARCHAR",
        "UUID": "UUID",
    }
    return mapping.get(rt, "VARCHAR")


def _insert_sample_rows(
    local,
    schema_name: str,
    table_name: str,
    rows: list[dict],
    columns: list[dict],
) -> None:
    """Insert sample rows into the local DuckDB table."""
    if not rows:
        return

    col_names = [f'"{col["name"]}"' for col in columns]
    placeholders = ", ".join(["?" for _ in columns])
    insert_sql = (
        f'INSERT INTO "{schema_name}"."{table_name}" '
        f'({", ".join(col_names)}) VALUES ({placeholders})'
    )

    for row in rows:
        values = tuple(row.get(col["name"]) for col in columns)
        try:
            local.execute(insert_sql, params=values)
        except Exception:
            pass  # Skip individual row errors
