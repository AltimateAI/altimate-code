"""Schema inspection for warehouse tables."""

from __future__ import annotations

from altimate_engine.models import SchemaColumn, SchemaInspectParams, SchemaInspectResult


def inspect_schema(params: SchemaInspectParams) -> SchemaInspectResult:
    """Inspect schema of a table in a warehouse.

    Currently a stub — will be extended with real warehouse introspection
    in a future phase.
    """
    if params.warehouse and params.warehouse.startswith("postgres"):
        return _inspect_postgres(params)

    return SchemaInspectResult(
        table=params.table,
        schema_name=params.schema_name,
        columns=[],
        row_count=None,
    )


def _inspect_postgres(params: SchemaInspectParams) -> SchemaInspectResult:
    """Inspect schema from a PostgreSQL database."""
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
