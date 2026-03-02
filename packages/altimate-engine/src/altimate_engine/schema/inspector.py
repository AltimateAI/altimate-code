"""Schema inspection for warehouse tables."""

from __future__ import annotations

from altimate_engine.connections import ConnectionRegistry
from altimate_engine.models import SchemaColumn, SchemaInspectParams, SchemaInspectResult


def inspect_schema(params: SchemaInspectParams) -> SchemaInspectResult:
    """Inspect schema of a table in a warehouse.

    Uses ConnectionRegistry to resolve named connections.
    Falls back to treating warehouse as a raw postgres connection string
    for backwards compatibility.
    """
    if not params.warehouse:
        return SchemaInspectResult(
            table=params.table,
            schema_name=params.schema_name,
            columns=[],
        )

    # Try ConnectionRegistry first
    try:
        connector = ConnectionRegistry.get(params.warehouse)
    except ValueError:
        # Fallback: treat as raw postgres connection string for backwards compat
        if params.warehouse.startswith("postgres"):
            return _inspect_postgres_raw(params)
        return SchemaInspectResult(
            table=params.table,
            schema_name=params.schema_name,
            columns=[],
        )

    try:
        connector.connect()
        schema = params.schema_name or "public"
        rows = connector.describe_table(schema, params.table)
        connector.close()

        columns = [
            SchemaColumn(
                name=row.get("name", ""),
                data_type=row.get("data_type", ""),
                nullable=bool(row.get("nullable", True)),
                primary_key=bool(row.get("primary_key", False)),
            )
            for row in rows
        ]

        return SchemaInspectResult(
            table=params.table,
            schema_name=schema,
            columns=columns,
        )
    except Exception:
        return SchemaInspectResult(
            table=params.table,
            schema_name=params.schema_name,
            columns=[],
        )


def _inspect_postgres_raw(params: SchemaInspectParams) -> SchemaInspectResult:
    """Legacy fallback: inspect schema from a raw PostgreSQL connection string."""
    try:
        import psycopg2
    except ImportError:
        return SchemaInspectResult(
            table=params.table,
            schema_name=params.schema_name,
            columns=[],
        )

    try:
        conn = psycopg2.connect(params.warehouse)
        cur = conn.cursor()

        schema = params.schema_name or "public"
        cur.execute(
            """
            SELECT column_name, data_type, is_nullable,
                   CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk
            FROM information_schema.columns c
            LEFT JOIN (
                SELECT kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                    AND tc.table_schema = %s
                    AND tc.table_name = %s
            ) pk ON c.column_name = pk.column_name
            WHERE c.table_schema = %s AND c.table_name = %s
            ORDER BY c.ordinal_position
            """,
            (schema, params.table, schema, params.table),
        )

        columns = [
            SchemaColumn(
                name=row[0],
                data_type=row[1],
                nullable=row[2] == "YES",
                primary_key=row[3],
            )
            for row in cur.fetchall()
        ]

        conn.close()
        return SchemaInspectResult(
            table=params.table,
            schema_name=schema,
            columns=columns,
        )
    except Exception:
        return SchemaInspectResult(
            table=params.table,
            schema_name=params.schema_name,
            columns=[],
        )
