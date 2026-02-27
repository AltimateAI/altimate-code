"""dbt model lineage — column-level lineage from manifest + model name."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from altimate_engine.sql.guard import guard_column_lineage
from altimate_engine.models import (
    DbtLineageParams,
    DbtLineageResult,
)

logger = logging.getLogger(__name__)


def dbt_lineage(params: DbtLineageParams) -> DbtLineageResult:
    """Compute column-level lineage for a dbt model.

    Loads the manifest, finds the target model (by name or unique_id),
    extracts its compiled SQL + upstream schemas, and delegates to
    sqlguard's column_lineage via guard_column_lineage.
    """
    manifest_path = Path(params.manifest_path)
    if not manifest_path.exists():
        return DbtLineageResult(
            model_name=params.model,
            confidence="low",
            confidence_factors=["Manifest file not found"],
        )

    try:
        with open(manifest_path) as f:
            manifest = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        return DbtLineageResult(
            model_name=params.model,
            confidence="low",
            confidence_factors=[f"Failed to parse manifest: {e}"],
        )

    nodes = manifest.get("nodes", {})
    sources = manifest.get("sources", {})

    # Find the target model by name or unique_id
    model_node = _find_model(nodes, params.model)
    if model_node is None:
        return DbtLineageResult(
            model_name=params.model,
            confidence="low",
            confidence_factors=[f"Model '{params.model}' not found in manifest"],
        )

    # Extract compiled SQL (v7+: compiled_code, older: compiled_sql)
    sql = model_node.get("compiled_code") or model_node.get("compiled_sql") or ""
    if not sql:
        return DbtLineageResult(
            model_name=params.model,
            confidence="low",
            confidence_factors=["No compiled SQL found — run `dbt compile` first"],
        )

    # Detect dialect from manifest metadata or adapter
    dialect = params.dialect
    if not dialect:
        dialect = _detect_dialect(manifest, model_node)

    # Build schema context from upstream dependencies
    upstream_ids = model_node.get("depends_on", {}).get("nodes", [])
    schema_context = _build_schema_context(nodes, sources, upstream_ids)

    # Delegate to sqlguard column_lineage
    raw = guard_column_lineage(
        sql,
        dialect=dialect,
        schema_context=schema_context if schema_context else None,
    )

    # Extract database/schema defaults from model node
    return DbtLineageResult(
        model_name=model_node.get("name", params.model),
        model_unique_id=_get_unique_id(nodes, params.model),
        compiled_sql=sql,
        raw_lineage=raw,
        confidence="high" if not raw.get("error") else "low",
        confidence_factors=[raw["error"]] if raw.get("error") else [],
    )


def _find_model(nodes: dict[str, Any], model: str) -> dict[str, Any] | None:
    """Find model node by name or unique_id."""
    if model in nodes:
        return nodes[model]
    for node_id, node in nodes.items():
        if node.get("resource_type") != "model":
            continue
        if node.get("name") == model:
            return node
    return None


def _get_unique_id(nodes: dict[str, Any], model: str) -> str | None:
    """Get unique_id for a model name."""
    if model in nodes:
        return model
    for node_id, node in nodes.items():
        if node.get("resource_type") == "model" and node.get("name") == model:
            return node_id
    return None


def _detect_dialect(manifest: dict[str, Any], model_node: dict[str, Any]) -> str:
    """Detect SQL dialect from manifest metadata."""
    metadata = manifest.get("metadata", {})
    adapter = metadata.get("adapter_type", "")
    if adapter:
        dialect_map = {
            "snowflake": "snowflake",
            "bigquery": "bigquery",
            "databricks": "databricks",
            "spark": "spark",
            "postgres": "postgres",
            "redshift": "redshift",
            "duckdb": "duckdb",
        }
        return dialect_map.get(adapter, adapter)
    return "snowflake"


def _build_schema_context(
    nodes: dict[str, Any],
    sources: dict[str, Any],
    upstream_ids: list[str],
) -> dict | None:
    """Build schema context from upstream model/source columns.

    Returns sqlguard schema format:
    {"tables": {"table_name": {"columns": [{"name": ..., "type": ...}]}}, "version": "1"}
    """
    tables: dict[str, dict] = {}

    for uid in upstream_ids:
        node = nodes.get(uid) or sources.get(uid)
        if node is None:
            continue

        table_name = node.get("alias") or node.get("name", "")
        if not table_name:
            continue

        columns_dict = node.get("columns", {})
        if not columns_dict:
            continue

        cols = [
            {"name": col.get("name", col_name), "type": col.get("data_type") or col.get("type") or ""}
            for col_name, col in columns_dict.items()
        ]

        if cols:
            tables[table_name] = {"columns": cols}

    if not tables:
        return None

    return {"tables": tables, "version": "1"}
