"""BigQuery warehouse connector with service account and ADC authentication."""

from __future__ import annotations

from typing import Any

from altimate_engine.connectors.base import Connector


class BigQueryConnector(Connector):
    """BigQuery connector using google-cloud-bigquery SDK.

    Supports:
    - Service account JSON key file
    - Application Default Credentials (ADC)
    """

    def __init__(
        self,
        project: str,
        credentials_path: str | None = None,
        location: str = "US",
        **kwargs,
    ):
        self.project = project
        self.credentials_path = credentials_path
        self.location = location
        self.kwargs = kwargs
        self._client = None
        self._timeout_ms: int | None = None

    def connect(self) -> Any:
        try:
            from google.cloud import bigquery
        except ImportError:
            raise ImportError(
                "google-cloud-bigquery not installed. Install with: pip install altimate-engine[warehouses]"
            )

        if self.credentials_path:
            try:
                from google.oauth2 import service_account

                creds = service_account.Credentials.from_service_account_file(
                    self.credentials_path
                )
                self._client = bigquery.Client(
                    project=self.project,
                    credentials=creds,
                    location=self.location,
                )
            except Exception as e:
                raise ValueError(
                    f"Failed to load service account credentials from {self.credentials_path}: {e}"
                )
        else:
            try:
                self._client = bigquery.Client(
                    project=self.project,
                    location=self.location,
                )
            except Exception as e:
                raise ValueError(
                    f"Failed to initialize BigQuery client with ADC. "
                    f"Run 'gcloud auth application-default login' or provide credentials_path. "
                    f"Error: {e}"
                )

        return self._client

    def _ensure_client(self):
        if self._client is None:
            self.connect()
        return self._client

    def execute(
        self, sql: str, params: tuple | list | None = None, limit: int = 1000
    ) -> list[dict[str, Any]]:
        from google.cloud import bigquery

        client = self._ensure_client()
        job_config = bigquery.QueryJobConfig()

        if self._timeout_ms:
            job_config.query_timeout_ms = self._timeout_ms // 1000

        if params:
            job_config.query_parameters = self._convert_params(params)

        try:
            job = client.query(sql, job_config=job_config)
            rows = job.result(max_results=limit)
            return [dict(row) for row in rows]
        except Exception as e:
            error_msg = str(e).lower()
            if "accessdenied" in error_msg or "permission" in error_msg:
                raise PermissionError(
                    f"BigQuery permission denied. Ensure the service account has "
                    f"'BigQuery Job User' and 'BigQuery Data Viewer' roles. Error: {e}"
                )
            raise

    def _convert_params(self, params: tuple | list) -> list:
        from google.cloud import bigquery

        converted = []
        for p in params:
            if isinstance(p, str):
                converted.append(bigquery.ScalarQueryParameter(None, "STRING", p))
            elif isinstance(p, int):
                converted.append(bigquery.ScalarQueryParameter(None, "INT64", p))
            elif isinstance(p, float):
                converted.append(bigquery.ScalarQueryParameter(None, "FLOAT64", p))
            elif isinstance(p, bool):
                converted.append(bigquery.ScalarQueryParameter(None, "BOOL", p))
            else:
                converted.append(bigquery.ScalarQueryParameter(None, "STRING", str(p)))
        return converted

    def list_schemas(self) -> list[str]:
        client = self._ensure_client()
        datasets = list(client.list_datasets())
        return [ds.dataset_id for ds in datasets]

    def list_tables(self, schema: str) -> list[dict[str, Any]]:
        client = self._ensure_client()
        dataset_ref = client.dataset(schema)
        tables = list(client.list_tables(dataset_ref))
        return [
            {"name": table.table_id, "type": table.table_type or "TABLE"}
            for table in tables
        ]

    def describe_table(self, schema: str, table: str) -> list[dict[str, Any]]:
        client = self._ensure_client()
        table_ref = client.dataset(schema).table(table)
        table_obj = client.get_table(table_ref)

        return [
            {
                "name": field.name,
                "data_type": field.field_type,
                "nullable": field.mode != "REQUIRED",
            }
            for field in table_obj.schema
        ]

    def set_statement_timeout(self, timeout_ms: int) -> None:
        self._timeout_ms = timeout_ms

    def dry_run(self, sql: str) -> dict[str, Any]:
        """Execute a dry run to estimate bytes billed without running the query.

        Returns:
            Dict with bytes_billed, bytes_processed, and estimated_cost_usd.
        """
        from google.cloud import bigquery

        client = self._ensure_client()
        job_config = bigquery.QueryJobConfig(dry_run=True, use_query_cache=False)

        try:
            job = client.query(sql, job_config=job_config)

            bytes_billed = job.total_bytes_billed or 0
            bytes_processed = job.total_bytes_processed or 0

            estimated_cost_usd = bytes_billed / 1e12 * 5.0

            return {
                "bytes_billed": bytes_billed,
                "bytes_processed": bytes_processed,
                "estimated_cost_usd": round(estimated_cost_usd, 6),
                "cache_hit": False,
            }
        except Exception as e:
            return {
                "bytes_billed": 0,
                "bytes_processed": 0,
                "estimated_cost_usd": 0,
                "cache_hit": False,
                "error": str(e),
            }

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None
