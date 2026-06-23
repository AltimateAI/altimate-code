import { describe, test, expect, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import { parseManifest } from "../../src/altimate/native/dbt/manifest"

describe("dbt manifest parser: edge cases", () => {
  const tmpFiles: string[] = []

  function writeTmpManifest(content: string): string {
    const tmpFile = path.join(os.tmpdir(), `manifest-edge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    fs.writeFileSync(tmpFile, content)
    tmpFiles.push(tmpFile)
    return tmpFile
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch {}
    }
    tmpFiles.length = 0
  })

  test("handles invalid JSON gracefully", async () => {
    const tmpFile = writeTmpManifest("not json at all {{{")
    const result = await parseManifest({ path: tmpFile })
    expect(result.models).toEqual([])
    expect(result.model_count).toBe(0)
  })

  test("handles manifest with no nodes or sources keys", async () => {
    const tmpFile = writeTmpManifest(JSON.stringify({ metadata: { dbt_version: "1.5.0" } }))
    const result = await parseManifest({ path: tmpFile })
    expect(result.models).toEqual([])
    expect(result.sources).toEqual([])
    expect(result.model_count).toBe(0)
    expect(result.source_count).toBe(0)
  })

  test("handles model with empty columns dict", async () => {
    const manifest = {
      nodes: {
        "model.my_project.my_model": {
          resource_type: "model",
          name: "my_model",
          schema: "public",
          database: "analytics",
          config: { materialized: "table" },
          depends_on: { nodes: [] },
          columns: {},
        },
      },
      sources: {},
    }
    const tmpFile = writeTmpManifest(JSON.stringify(manifest))
    const result = await parseManifest({ path: tmpFile })
    expect(result.model_count).toBe(1)
    expect(result.models[0].columns).toEqual([])
    expect(result.models[0].name).toBe("my_model")
  })

  test("handles model missing depends_on entirely", async () => {
    const manifest = {
      nodes: {
        "model.project.orphan": {
          resource_type: "model",
          name: "orphan",
          columns: {},
        },
      },
      sources: {},
    }
    const tmpFile = writeTmpManifest(JSON.stringify(manifest))
    const result = await parseManifest({ path: tmpFile })
    expect(result.model_count).toBe(1)
    expect(result.models[0].depends_on).toEqual([])
  })

  test("handles null manifest content (JSON null)", async () => {
    const tmpFile = writeTmpManifest("null")
    const result = await parseManifest({ path: tmpFile })
    expect(result.models).toEqual([])
  })

  // Primary-key resolution for fan-out detection (L037).
  test("resolves primary_key from a contract constraint", async () => {
    const manifest = {
      nodes: {
        "model.p.dim": {
          resource_type: "model",
          name: "dim",
          constraints: [{ type: "primary_key", columns: ["id"] }],
          columns: { id: { name: "id" }, label: { name: "label" } },
        },
      },
      sources: {},
    }
    const r = await parseManifest({ path: writeTmpManifest(JSON.stringify(manifest)) })
    expect(r.models[0].primary_key).toEqual(["id"])
  })

  test("resolves primary_key from a column-level primary_key constraint", async () => {
    const manifest = {
      nodes: {
        "model.p.events": {
          resource_type: "model",
          name: "events",
          columns: {
            event_id: { name: "event_id", constraints: [{ type: "primary_key" }] },
            user_id: { name: "user_id" },
          },
        },
      },
      sources: {},
    }
    const r = await parseManifest({ path: writeTmpManifest(JSON.stringify(manifest)) })
    expect(r.models[0].primary_key).toEqual(["event_id"])
  })

  test("resolves primary_key from an unambiguous unique_combination_of_columns test", async () => {
    const manifest = {
      nodes: {
        "model.p.cols": { resource_type: "model", name: "cols", columns: {} },
        "test.p.uc": {
          resource_type: "test",
          name: "unique_combination_cols",
          attached_node: "model.p.cols",
          depends_on: { nodes: ["model.p.cols"] },
          test_metadata: { name: "unique_combination_of_columns", kwargs: { combination_of_columns: ["account", "full_column_name"] } },
        },
      },
      sources: {},
    }
    const r = await parseManifest({ path: writeTmpManifest(JSON.stringify(manifest)) })
    expect(r.models[0].primary_key).toEqual(["account", "full_column_name"])
  })

  test("does NOT set primary_key when multiple distinct unique tests are ambiguous", async () => {
    const manifest = {
      nodes: {
        "model.p.m": { resource_type: "model", name: "m", columns: {} },
        "test.p.u1": {
          resource_type: "test", name: "u_a", depends_on: { nodes: ["model.p.m"] },
          test_metadata: { name: "unique", kwargs: { column_name: "a" } },
        },
        "test.p.u2": {
          resource_type: "test", name: "u_b", depends_on: { nodes: ["model.p.m"] },
          test_metadata: { name: "unique", kwargs: { column_name: "b" } },
        },
      },
      sources: {},
    }
    const r = await parseManifest({ path: writeTmpManifest(JSON.stringify(manifest)) })
    expect(r.models[0].primary_key).toBeUndefined()
  })

  test("extracts source columns with type fallback", async () => {
    const manifest = {
      nodes: {},
      sources: {
        "source.project.raw.orders": {
          name: "orders",
          source_name: "raw",
          schema: "raw_data",
          database: "warehouse",
          columns: {
            id: { name: "id", data_type: "INTEGER", description: "Primary key" },
            created_at: { name: "created_at", type: "TIMESTAMP" },
          },
        },
      },
    }
    const tmpFile = writeTmpManifest(JSON.stringify(manifest))
    const result = await parseManifest({ path: tmpFile })
    expect(result.source_count).toBe(1)
    expect(result.sources[0].name).toBe("orders")
    expect(result.sources[0].source_name).toBe("raw")
    expect(result.sources[0].columns).toHaveLength(2)
    expect(result.sources[0].columns[0].data_type).toBe("INTEGER")
    // Second column uses "type" fallback instead of "data_type"
    expect(result.sources[0].columns[1].data_type).toBe("TIMESTAMP")
  })
})
