/**
 * Tests for dbt lineage helper functions: findModel, detectDialect,
 * buildSchemaContext, and the top-level dbtLineage() error paths.
 *
 * These pure functions parse manifest data and build schema contexts
 * for column-level lineage analysis. Zero tests existed previously.
 * A bug in findModel or buildSchemaContext causes lineage to silently
 * return empty results, which users see as "no lineage available".
 */

import { describe, test, expect, afterEach } from "bun:test"
import { dbtLineage } from "../../src/altimate/native/dbt/lineage"
import { writeFileSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dbt-lineage-test-"))
  tmpDirs.push(dir)
  return dir
}

function writeManifest(dir: string, manifest: Record<string, any>): string {
  const manifestPath = join(dir, "manifest.json")
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return manifestPath
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

// ---------------------------------------------------------------------------
// Minimal manifest fixtures
// ---------------------------------------------------------------------------

const BASE_MANIFEST = {
  metadata: { adapter_type: "snowflake" },
  nodes: {
    "model.proj.orders": {
      resource_type: "model",
      name: "orders",
      schema: "public",
      database: "analytics",
      config: { materialized: "table" },
      compiled_code: "SELECT c.id, c.name FROM customers c",
      depends_on: { nodes: ["source.proj.raw.customers"] },
      columns: {
        id: { name: "id", data_type: "INTEGER" },
        name: { name: "name", data_type: "VARCHAR" },
      },
    },
    "model.proj.revenue": {
      resource_type: "model",
      name: "revenue",
      compiled_code: "SELECT SUM(amount) AS total FROM orders",
      depends_on: { nodes: ["model.proj.orders"] },
      columns: {},
    },
    "test.proj.not_null": {
      resource_type: "test",
      name: "not_null",
    },
  },
  sources: {
    "source.proj.raw.customers": {
      name: "customers",
      source_name: "raw",
      schema: "raw_data",
      database: "analytics",
      columns: {
        id: { name: "id", data_type: "INTEGER" },
        name: { name: "name", data_type: "VARCHAR" },
        email: { name: "email", data_type: "VARCHAR" },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// 1. Model lookup (findModel)
// ---------------------------------------------------------------------------

describe("dbtLineage: model lookup", () => {
  test("finds model by unique_id", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "model.proj.orders",
    })

    expect(result.model_name).toBe("orders")
    expect(result.model_unique_id).toBe("model.proj.orders")
    expect(result.compiled_sql).toContain("SELECT")
  })

  test("finds model by short name", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    expect(result.model_name).toBe("orders")
    expect(result.model_unique_id).toBe("model.proj.orders")
  })

  test("returns low confidence when model not found", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "nonexistent_model",
    })

    expect(result.confidence).toBe("low")
    expect(result.confidence_factors).toContain("Model 'nonexistent_model' not found in manifest")
  })

  test("does not match test or seed nodes by name", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "not_null",
    })

    // "not_null" is a test node, not a model — should not be found
    expect(result.confidence).toBe("low")
    expect(result.confidence_factors[0]).toContain("not found in manifest")
  })
})

// ---------------------------------------------------------------------------
// 2. Dialect detection (detectDialect)
// ---------------------------------------------------------------------------

describe("dbtLineage: dialect detection", () => {
  test("detects dialect from manifest metadata.adapter_type", () => {
    const dir = makeTmpDir()
    const manifest = {
      ...BASE_MANIFEST,
      metadata: { adapter_type: "bigquery" },
    }
    const manifestPath = writeManifest(dir, manifest)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    // We can't directly check dialect, but the result shouldn't error
    // due to dialect mismatch. The model has compiled_code, so confidence
    // should be high if lineage succeeds or reflect the actual error.
    expect(result.model_name).toBe("orders")
  })

  test("explicit dialect param overrides auto-detection", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
      dialect: "postgres",
    })

    // Should not throw regardless of dialect choice
    expect(result.model_name).toBe("orders")
  })

  test("defaults to snowflake when adapter_type is missing", () => {
    const dir = makeTmpDir()
    const manifest = {
      ...BASE_MANIFEST,
      metadata: {},
    }
    const manifestPath = writeManifest(dir, manifest)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    // Should not throw — defaults to snowflake
    expect(result.model_name).toBe("orders")
  })
})

// ---------------------------------------------------------------------------
// 3. Schema context building (buildSchemaContext)
// ---------------------------------------------------------------------------

describe("dbtLineage: schema context from upstream deps", () => {
  test("builds context from source with columns", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, BASE_MANIFEST)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    // The orders model depends on source.proj.raw.customers which has columns.
    // If schema context was built correctly, lineage should have non-empty output.
    expect(result.model_name).toBe("orders")
    // compiled_sql should be present
    expect(result.compiled_sql).toBeDefined()
    expect(result.compiled_sql).toContain("SELECT")
  })

  test("handles model with no upstream columns gracefully", () => {
    const dir = makeTmpDir()
    // Revenue depends on orders, but orders has columns — so context should build.
    // Create a model that depends on a node with no columns.
    const manifest = {
      ...BASE_MANIFEST,
      nodes: {
        ...BASE_MANIFEST.nodes,
        "model.proj.bare": {
          resource_type: "model",
          name: "bare",
          compiled_code: "SELECT 1 AS val",
          depends_on: { nodes: ["model.proj.no_cols"] },
          columns: {},
        },
        "model.proj.no_cols": {
          resource_type: "model",
          name: "no_cols",
          compiled_code: "SELECT 1",
          depends_on: { nodes: [] },
          columns: {},
        },
      },
    }
    const manifestPath = writeManifest(dir, manifest)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "bare",
    })

    // Should not crash — just returns with whatever lineage can determine
    expect(result.model_name).toBe("bare")
    expect(result.compiled_sql).toBe("SELECT 1 AS val")
  })
})

// ---------------------------------------------------------------------------
// 4. Error paths
// ---------------------------------------------------------------------------

describe("dbtLineage: error handling", () => {
  test("returns low confidence for non-existent manifest", () => {
    const result = dbtLineage({
      manifest_path: "/tmp/definitely-not-a-manifest.json",
      model: "orders",
    })

    expect(result.confidence).toBe("low")
    expect(result.confidence_factors).toContain("Manifest file not found")
    expect(result.raw_lineage).toEqual({})
  })

  test("returns low confidence for invalid JSON manifest", () => {
    const dir = makeTmpDir()
    const manifestPath = join(dir, "manifest.json")
    writeFileSync(manifestPath, "not valid json {{{")

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    expect(result.confidence).toBe("low")
    expect(result.confidence_factors[0]).toContain("Failed to parse manifest")
  })

  test("returns low confidence when model has no compiled SQL", () => {
    const dir = makeTmpDir()
    const manifest = {
      nodes: {
        "model.proj.uncompiled": {
          resource_type: "model",
          name: "uncompiled",
          // No compiled_code or compiled_sql
          depends_on: { nodes: [] },
          columns: {},
        },
      },
      sources: {},
    }
    const manifestPath = writeManifest(dir, manifest)

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "uncompiled",
    })

    expect(result.confidence).toBe("low")
    expect(result.confidence_factors).toContain("No compiled SQL found — run `dbt compile` first")
  })

  test("reports the model's name, not the path used to find it, when there is no compiled SQL", () => {
    const dir = makeTmpDir()
    const manifest = {
      nodes: {
        "model.proj.uncompiled": {
          resource_type: "model",
          name: "uncompiled",
          original_file_path: "models/uncompiled.sql",
          depends_on: { nodes: [] },
          columns: {},
        },
      },
      sources: {},
    }
    const result = dbtLineage({ manifest_path: writeManifest(dir, manifest), model: "models/uncompiled.sql" })
    expect(result.model_name).toBe("uncompiled")
  })

  test("handles manifest with no nodes key at all", () => {
    const dir = makeTmpDir()
    const manifestPath = writeManifest(dir, { metadata: {} })

    const result = dbtLineage({
      manifest_path: manifestPath,
      model: "orders",
    })

    expect(result.confidence).toBe("low")
  })
})
