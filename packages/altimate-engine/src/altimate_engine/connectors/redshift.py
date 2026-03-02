"""Redshift warehouse connector — extends PostgresConnector with IAM auth."""

from __future__ import annotations

from typing import Any

from altimate_engine.connectors.postgres import PostgresConnector


class RedshiftConnector(PostgresConnector):
    """Amazon Redshift connector extending PostgresConnector.

    Supports:
    - Password auth (inherited from PostgresConnector)
    - IAM role-based auth via boto3 temporary credentials
    """

    def __init__(
        self,
        host: str = "",
        port: int = 5439,  # Redshift default port
        database: str = "dev",
        user: str | None = None,
        password: str | None = None,
        connection_string: str | None = None,
        iam_role: str | None = None,
        region: str | None = None,
        cluster_identifier: str | None = None,
        **kwargs,
    ):
        self.iam_role = iam_role
        self.region = region
        self.cluster_identifier = cluster_identifier
        super().__init__(
            host=host,
            port=port,
            database=database,
            user=user,
            password=password,
            connection_string=connection_string,
            **kwargs,
        )

    def connect(self) -> Any:
        if self.iam_role and not self.password:
            self._resolve_iam_credentials()
        return super().connect()

    def _resolve_iam_credentials(self):
        """Get temporary credentials via IAM role assumption."""
        try:
            import boto3
        except ImportError:
            raise ImportError(
                "boto3 not installed. Install with: pip install boto3"
            )

        if not self.cluster_identifier:
            raise ValueError(
                "cluster_identifier is required for IAM authentication. "
                "This is the Redshift cluster ID (not the full endpoint)."
            )

        client = boto3.client(
            "redshift",
            region_name=self.region or "us-east-1",
        )
        response = client.get_cluster_credentials(
            DbUser=self.user or "admin",
            DbName=self.database,
            ClusterIdentifier=self.cluster_identifier,
        )
        self.user = response["DbUser"]
        self.password = response["DbPassword"]

    def list_schemas(self) -> list[str]:
        rows = self.execute(
            "SELECT schema_name FROM svv_all_schemas "
            "WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_internal')"
        )
        return [row["schema_name"] for row in rows]

    def list_tables(self, schema: str) -> list[dict[str, Any]]:
        rows = self.execute(
            "SELECT table_name, table_type FROM svv_all_tables WHERE schema_name = %s",
            (schema,),
        )
        return [
            {"name": row["table_name"], "type": row.get("table_type", "TABLE")}
            for row in rows
        ]

    def describe_table(self, schema: str, table: str) -> list[dict[str, Any]]:
        rows = self.execute(
            "SELECT column_name, data_type, is_nullable FROM svv_all_columns "
            "WHERE schema_name = %s AND table_name = %s ORDER BY ordinal_position",
            (schema, table),
        )
        return [
            {
                "name": row["column_name"],
                "data_type": row["data_type"],
                "nullable": row.get("is_nullable", "YES") == "YES",
            }
            for row in rows
        ]
