"""dbt manifest.json parser."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from altimate_engine.models import (
    DbtManifestParams,
    DbtManifestResult,
    DbtModelInfo,
    DbtSourceInfo,
    ModelColumn,
)

logger = logging.getLogger(__name__)

# Manifests above this size get a warning; ijson could be added for streaming
_LARGE_MANIFEST_BYTES = 50 * 1024 * 1024  # 50 MB


def _extract_columns(columns_dict: dict) -> list[ModelColumn]:
    """Convert a manifest columns dict to a list of ModelColumn objects."""
    return [
        ModelColumn(
            name=col.get("name", col_name),
            data_type=col.get("data_type") or col.get("type") or "",
            description=col.get("description") or None,
        )
        for col_name, col in columns_dict.items()
    ]


def parse_manifest(params: DbtManifestParams) -> DbtManifestResult:
    """Parse a dbt manifest.json file and extract model, source, and node information."""
    manifest_path = Path(params.path)

    if not manifest_path.exists():
        return DbtManifestResult()

    file_size = manifest_path.stat().st_size
    if file_size > _LARGE_MANIFEST_BYTES:
        logger.warning(
            "Manifest is %d MB; consider adding ijson for streaming parse",
            file_size // (1024 * 1024),
        )

    try:
        with open(manifest_path) as f:
            manifest = json.load(f)
    except (json.JSONDecodeError, OSError):
        return DbtManifestResult()

    if not isinstance(manifest, dict):
        return DbtManifestResult()

    nodes = manifest.get("nodes", {})
    sources_dict = manifest.get("sources", {})

    models: list[DbtModelInfo] = []
    test_count = 0
    snapshot_count = 0
    seed_count = 0

    for node_id, node in nodes.items():
        resource_type = node.get("resource_type")

        if resource_type == "model":
            depends_on_nodes = node.get("depends_on", {}).get("nodes", [])
            columns = _extract_columns(node.get("columns", {}))
            models.append(
                DbtModelInfo(
                    unique_id=node_id,
                    name=node.get("name", ""),
                    schema_name=node.get("schema"),
                    database=node.get("database"),
                    materialized=node.get("config", {}).get("materialized"),
                    depends_on=depends_on_nodes,
                    columns=columns,
                )
            )
        elif resource_type == "test":
            test_count += 1
        elif resource_type == "snapshot":
            snapshot_count += 1
        elif resource_type == "seed":
            seed_count += 1

    sources: list[DbtSourceInfo] = []
    for source_id, source in sources_dict.items():
        columns = _extract_columns(source.get("columns", {}))
        sources.append(
            DbtSourceInfo(
                unique_id=source_id,
                name=source.get("name", ""),
                source_name=source.get("source_name", ""),
                schema_name=source.get("schema"),
                database=source.get("database"),
                columns=columns,
            )
        )

    return DbtManifestResult(
        models=models,
        sources=sources,
        source_count=len(sources),
        model_count=len(models),
        test_count=test_count,
        snapshot_count=snapshot_count,
        seed_count=seed_count,
    )
