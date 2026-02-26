"""Tests for dbt/manifest.py — dbt manifest.json parser."""

import json
import os

import pytest

from altimate_engine.dbt.manifest import parse_manifest, _extract_columns
from altimate_engine.models import DbtManifestParams, DbtManifestResult, DbtModelInfo, DbtSourceInfo, ModelColumn


def _write_manifest(tmp_path, manifest_data: dict) -> str:
    """Helper to write a manifest dict to a JSON file and return its path."""
    path = str(tmp_path / "manifest.json")
    with open(path, "w") as f:
        json.dump(manifest_data, f)
    return path


def _minimal_manifest(
    models=None, sources=None, tests=0, snapshots=0, seeds=0
) -> dict:
    """Build a minimal manifest dict with configurable node types."""
    nodes = {}

    for model in (models or []):
        unique_id = model.get("unique_id", f"model.project.{model['name']}")
        nodes[unique_id] = {
            "resource_type": "model",
            "name": model.get("name"),
            "schema": model.get("schema"),
            "database": model.get("database"),
            "config": {"materialized": model.get("materialized", "view")},
            "depends_on": {"nodes": model.get("depends_on", [])},
            "columns": model.get("columns", {}),
        }

    for i in range(tests):
        test_id = f"test.project.test_{i}"
        nodes[test_id] = {"resource_type": "test", "name": f"test_{i}"}

    for i in range(snapshots):
        snap_id = f"snapshot.project.snap_{i}"
        nodes[snap_id] = {"resource_type": "snapshot", "name": f"snap_{i}"}

    for i in range(seeds):
        seed_id = f"seed.project.seed_{i}"
        nodes[seed_id] = {"resource_type": "seed", "name": f"seed_{i}"}

    sources_dict = {}
    for source in (sources or []):
        source_id = source.get("unique_id", f"source.project.{source['source_name']}.{source['name']}")
        sources_dict[source_id] = {
            "name": source.get("name"),
            "source_name": source.get("source_name"),
            "schema": source.get("schema"),
            "database": source.get("database"),
            "columns": source.get("columns", {}),
        }

    return {"nodes": nodes, "sources": sources_dict}


class TestParseManifestBasic:
    """Core manifest parsing."""

    def test_minimal_manifest_with_one_model(self, tmp_path):
        """Parse a manifest with a single model."""
        manifest = _minimal_manifest(models=[{"name": "users", "schema": "public", "database": "analytics"}])
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))

        assert isinstance(result, DbtManifestResult)
        assert result.model_count == 1
        assert len(result.models) == 1
        assert result.models[0].name == "users"
        assert result.models[0].schema_name == "public"
        assert result.models[0].database == "analytics"

    def test_manifest_with_multiple_models(self, tmp_path):
        """Parse a manifest with multiple models."""
        manifest = _minimal_manifest(
            models=[
                {"name": "users", "schema": "public"},
                {"name": "orders", "schema": "public"},
                {"name": "products", "schema": "catalog"},
            ]
        )
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.model_count == 3
        names = {m.name for m in result.models}
        assert names == {"users", "orders", "products"}

    def test_manifest_with_sources(self, tmp_path):
        """Parse sources from the manifest."""
        manifest = _minimal_manifest(
            sources=[
                {
                    "name": "raw_users",
                    "source_name": "raw",
                    "schema": "raw_data",
                    "database": "warehouse",
                }
            ]
        )
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.source_count == 1
        assert len(result.sources) == 1
        assert result.sources[0].name == "raw_users"
        assert result.sources[0].source_name == "raw"
        assert result.sources[0].schema_name == "raw_data"
        assert result.sources[0].database == "warehouse"

    def test_empty_manifest(self, tmp_path):
        """An empty manifest (valid JSON, no nodes) should return empty result."""
        path = _write_manifest(tmp_path, {"nodes": {}, "sources": {}})

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.model_count == 0
        assert result.source_count == 0
        assert result.test_count == 0
        assert result.snapshot_count == 0
        assert result.seed_count == 0
        assert result.models == []
        assert result.sources == []

    def test_manifest_without_nodes_key(self, tmp_path):
        """Manifest without 'nodes' key should return empty result (not error)."""
        path = _write_manifest(tmp_path, {"metadata": {"dbt_version": "1.0.0"}})

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.model_count == 0
        assert result.source_count == 0


class TestParseManifestNodeTypes:
    """Counting different node types (models, tests, snapshots, seeds)."""

    def test_count_tests(self, tmp_path):
        manifest = _minimal_manifest(tests=5)
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.test_count == 5
        assert result.model_count == 0

    def test_count_snapshots(self, tmp_path):
        manifest = _minimal_manifest(snapshots=3)
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.snapshot_count == 3

    def test_count_seeds(self, tmp_path):
        manifest = _minimal_manifest(seeds=2)
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.seed_count == 2

    def test_mixed_node_types(self, tmp_path):
        """All node types counted correctly together."""
        manifest = _minimal_manifest(
            models=[{"name": "m1", "schema": "s1"}, {"name": "m2", "schema": "s1"}],
            sources=[{"name": "src1", "source_name": "raw", "schema": "raw"}],
            tests=4,
            snapshots=2,
            seeds=1,
        )
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.model_count == 2
        assert result.source_count == 1
        assert result.test_count == 4
        assert result.snapshot_count == 2
        assert result.seed_count == 1


class TestParseManifestModelDetails:
    """Detailed model extraction: unique_id, materialized, depends_on, columns."""

    def test_unique_id_extraction(self, tmp_path):
        """unique_id should be the node key from the manifest."""
        manifest = _minimal_manifest(
            models=[{"name": "users", "unique_id": "model.my_project.users", "schema": "public"}]
        )
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.models[0].unique_id == "model.my_project.users"

    def test_materialized_extraction(self, tmp_path):
        """Materialization strategy should be extracted from config."""
        manifest = _minimal_manifest(
            models=[{"name": "users", "schema": "public", "materialized": "table"}]
        )
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.models[0].materialized == "table"

    def test_depends_on_extraction(self, tmp_path):
        """depends_on.nodes should be extracted."""
        manifest = _minimal_manifest(
            models=[
                {
                    "name": "order_summary",
                    "schema": "public",
                    "depends_on": ["model.project.orders", "model.project.customers"],
                }
            ]
        )
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert len(result.models[0].depends_on) == 2
        assert "model.project.orders" in result.models[0].depends_on
        assert "model.project.customers" in result.models[0].depends_on


class TestParseManifestColumns:
    """Column extraction with descriptions."""

    def test_columns_extraction(self, tmp_path):
        """Columns should be extracted with name, data_type, and description."""
        manifest = _minimal_manifest(
            models=[
                {
                    "name": "users",
                    "schema": "public",
                    "columns": {
                        "id": {"name": "id", "data_type": "INTEGER", "description": "Primary key"},
                        "email": {"name": "email", "data_type": "VARCHAR", "description": "User email"},
                    },
                }
            ]
        )
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        cols = result.models[0].columns
        assert len(cols) == 2
        col_names = {c.name for c in cols}
        assert col_names == {"id", "email"}

        id_col = next(c for c in cols if c.name == "id")
        assert id_col.data_type == "INTEGER"
        assert id_col.description == "Primary key"

    def test_columns_with_type_alias(self, tmp_path):
        """Some manifests use 'type' instead of 'data_type'."""
        manifest = _minimal_manifest(
            models=[
                {
                    "name": "t1",
                    "schema": "s",
                    "columns": {
                        "col1": {"name": "col1", "type": "TEXT"},
                    },
                }
            ]
        )
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.models[0].columns[0].data_type == "TEXT"

    def test_columns_with_no_description(self, tmp_path):
        """Columns without descriptions should have None."""
        manifest = _minimal_manifest(
            models=[
                {
                    "name": "t1",
                    "schema": "s",
                    "columns": {
                        "col1": {"name": "col1", "data_type": "INT"},
                    },
                }
            ]
        )
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.models[0].columns[0].description is None

    def test_columns_empty_description_is_none(self, tmp_path):
        """Empty string description should be coerced to None."""
        manifest = _minimal_manifest(
            models=[
                {
                    "name": "t1",
                    "schema": "s",
                    "columns": {
                        "col1": {"name": "col1", "data_type": "INT", "description": ""},
                    },
                }
            ]
        )
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        # Empty string description should become None (see _extract_columns logic: `or None`)
        assert result.models[0].columns[0].description is None

    def test_source_columns(self, tmp_path):
        """Source columns should also be extracted."""
        manifest = _minimal_manifest(
            sources=[
                {
                    "name": "raw_users",
                    "source_name": "raw",
                    "schema": "raw_data",
                    "columns": {
                        "user_id": {"name": "user_id", "data_type": "BIGINT", "description": "User identifier"},
                    },
                }
            ]
        )
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert len(result.sources[0].columns) == 1
        assert result.sources[0].columns[0].name == "user_id"
        assert result.sources[0].columns[0].data_type == "BIGINT"


class TestParseManifestEdgeCases:
    """Error handling and edge cases."""

    def test_missing_manifest_file(self, tmp_path):
        """A non-existent path should return empty result."""
        path = str(tmp_path / "does_not_exist.json")
        result = parse_manifest(DbtManifestParams(path=path))
        assert isinstance(result, DbtManifestResult)
        assert result.model_count == 0
        assert result.source_count == 0

    def test_invalid_json(self, tmp_path):
        """Corrupt JSON should return empty result."""
        path = str(tmp_path / "bad.json")
        with open(path, "w") as f:
            f.write("{this is not valid json!!!")

        result = parse_manifest(DbtManifestParams(path=path))
        assert isinstance(result, DbtManifestResult)
        assert result.model_count == 0

    def test_empty_file(self, tmp_path):
        """Completely empty file should return empty result."""
        path = str(tmp_path / "empty.json")
        with open(path, "w") as f:
            f.write("")

        result = parse_manifest(DbtManifestParams(path=path))
        assert isinstance(result, DbtManifestResult)
        assert result.model_count == 0

    def test_json_array_instead_of_object(self, tmp_path):
        """A JSON array (not an object) should return empty result (no 'nodes' key)."""
        path = _write_manifest(tmp_path, [1, 2, 3])
        # Note: _write_manifest uses json.dump which handles arrays too
        # But parse_manifest expects dict-like .get("nodes")
        result = parse_manifest(DbtManifestParams(path=path))
        assert isinstance(result, DbtManifestResult)
        assert result.model_count == 0

    def test_model_with_missing_fields(self, tmp_path):
        """Models with missing optional fields should still parse."""
        manifest = {
            "nodes": {
                "model.p.m": {
                    "resource_type": "model",
                    "name": "m",
                    # No schema, no database, no config, no depends_on, no columns
                }
            },
            "sources": {},
        }
        path = _write_manifest(tmp_path, manifest)

        result = parse_manifest(DbtManifestParams(path=path))
        assert result.model_count == 1
        assert result.models[0].name == "m"
        assert result.models[0].schema_name is None
        assert result.models[0].materialized is None
        assert result.models[0].depends_on == []
        assert result.models[0].columns == []


class TestExtractColumns:
    """Test the _extract_columns helper directly."""

    def test_basic_extraction(self):
        cols_dict = {
            "id": {"name": "id", "data_type": "INT"},
            "name": {"name": "name", "data_type": "VARCHAR", "description": "Full name"},
        }
        result = _extract_columns(cols_dict)
        assert len(result) == 2
        assert all(isinstance(c, ModelColumn) for c in result)

    def test_empty_dict(self):
        result = _extract_columns({})
        assert result == []

    def test_fallback_to_col_name_key(self):
        """If 'name' key is missing, the dict key is used."""
        cols_dict = {"my_col": {"data_type": "TEXT"}}
        result = _extract_columns(cols_dict)
        assert result[0].name == "my_col"

    def test_missing_data_type(self):
        """Missing data_type should default to empty string."""
        cols_dict = {"col1": {"name": "col1"}}
        result = _extract_columns(cols_dict)
        assert result[0].data_type == ""
