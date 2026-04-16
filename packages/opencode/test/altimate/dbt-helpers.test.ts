/**
 * Direct unit tests for dbt native helper functions in
 * src/altimate/native/dbt/helpers.ts.
 *
 * These pure functions power dbt-lineage, dbt-unit-test-gen, and
 * dbt-manifest handlers. Previously only tested indirectly through
 * dbtLineage() in dbt-lineage-helpers.test.ts. Direct tests catch
 * regressions in isolation: a broken findModel or detectDialect
 * silently degrades multiple downstream tools.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import {
  loadRawManifest,
  findModel,
  getUniqueId,
  detectDialect,
  buildSchemaContext,
  extractColumns,
  listModelNames,
} from "../../src/altimate/native/dbt/helpers"

// ---------- findModel ----------

describe("findModel", () => {
  const nodes: Record<string, any> = {
    "model.project.orders": { resource_type: "model", name: "orders" },
    "model.project.users": { resource_type: "model", name: "users" },
    "source.project.raw.events": { resource_type: "source", name: "events" },
    "test.project.not_null": { resource_type: "test", name: "not_null" },
  }

  test("finds model by exact unique_id key", () => {
    expect(findModel(nodes, "model.project.orders")).toEqual(nodes["model.project.orders"])
  })

  test("finds model by name when unique_id does not match", () => {
    expect(findModel(nodes, "users")).toEqual(nodes["model.project.users"])
  })

  test("returns null for source nodes (not resource_type=model)", () => {
    expect(findModel(nodes, "events")).toBeNull()
  })

  test("returns null for nonexistent model", () => {
    expect(findModel(nodes, "nonexistent")).toBeNull()
  })

  test("returns null for empty nodes", () => {
    expect(findModel({}, "orders")).toBeNull()
  })

  test("returns a model when multiple models share the same name", () => {
    const dupes: Record<string, any> = {
      "model.a.orders": { resource_type: "model", name: "orders" },
      "model.b.orders": { resource_type: "model", name: "orders" },
    }
    const result = findModel(dupes, "orders")
    expect(result).not.toBeNull()
    expect(result.resource_type).toBe("model")
  })
})

// ---------- getUniqueId ----------

describe("getUniqueId", () => {
  const nodes: Record<string, any> = {
    "model.project.orders": { resource_type: "model", name: "orders" },
    "source.project.raw.events": { resource_type: "source", name: "events" },
  }

  test("returns key when exact unique_id exists and is a model", () => {
    expect(getUniqueId(nodes, "model.project.orders")).toBe("model.project.orders")
  })

  test("returns unique_id when looked up by name", () => {
    expect(getUniqueId(nodes, "orders")).toBe("model.project.orders")
  })

  test("returns undefined for source node (not resource_type=model)", () => {
    expect(getUniqueId(nodes, "events")).toBeUndefined()
  })

  test("returns undefined for nonexistent model", () => {
    expect(getUniqueId(nodes, "nonexistent")).toBeUndefined()
  })

  test("does not match test nodes by name", () => {
    const nodesWithTest: Record<string, any> = {
      ...nodes,
      "test.project.not_null": { resource_type: "test", name: "not_null" },
    }
    expect(getUniqueId(nodesWithTest, "not_null")).toBeUndefined()
  })

  test("does not match seed nodes by name", () => {
    const nodesWithSeed: Record<string, any> = {
      ...nodes,
      "seed.project.country_codes": { resource_type: "seed", name: "country_codes" },
    }
    expect(getUniqueId(nodesWithSeed, "country_codes")).toBeUndefined()
  })

  test("does not match by unique_id if resource_type is not model", () => {
    expect(getUniqueId(nodes, "source.project.raw.events")).toBeUndefined()
  })
})

// ---------- detectDialect ----------

describe("detectDialect", () => {
  test("maps known adapter types to dialect strings", () => {
    const cases: Array<[string, string]> = [
      ["snowflake", "snowflake"],
      ["bigquery", "bigquery"],
      ["databricks", "databricks"],
      ["spark", "spark"],
      ["postgres", "postgres"],
      ["redshift", "redshift"],
      ["duckdb", "duckdb"],
      ["clickhouse", "clickhouse"],
      ["mysql", "mysql"],
      ["sqlserver", "tsql"],
      ["trino", "trino"],
    ]
    for (const [adapter, expected] of cases) {
      expect(detectDialect({ metadata: { adapter_type: adapter } })).toBe(expected)
    }
  })

  test("returns unmapped adapter type verbatim (truthy passthrough)", () => {
    expect(detectDialect({ metadata: { adapter_type: "athena" } })).toBe("athena")
  })

  test("defaults to 'snowflake' when no metadata", () => {
    expect(detectDialect({})).toBe("snowflake")
  })

  test("defaults to 'snowflake' when adapter_type is empty string", () => {
    expect(detectDialect({ metadata: { adapter_type: "" } })).toBe("snowflake")
  })

  test("defaults to 'snowflake' when metadata is null", () => {
    expect(detectDialect({ metadata: null })).toBe("snowflake")
  })
})

// ---------- buildSchemaContext ----------

describe("buildSchemaContext", () => {
  const nodes: Record<string, any> = {
    "model.project.upstream_a": {
      resource_type: "model",
      name: "upstream_a",
      alias: "upstream_alias",
      columns: {
        id: { name: "id", data_type: "INTEGER" },
        name: { name: "name", data_type: "VARCHAR" },
      },
    },
    "model.project.upstream_b": {
      resource_type: "model",
      name: "upstream_b",
      columns: {},
    },
  }
  const sources: Record<string, any> = {
    "source.project.raw.events": {
      name: "events",
      columns: {
        event_id: { name: "event_id", data_type: "BIGINT" },
      },
    },
  }

  test("builds schema context using alias over name", () => {
    const result = buildSchemaContext(nodes, sources, ["model.project.upstream_a"])
    expect(result).not.toBeNull()
    expect(result!.version).toBe("1")
    // Alias takes precedence over name
    expect(result!.tables["upstream_alias"]).toBeDefined()
    expect(result!.tables["upstream_alias"].columns).toHaveLength(2)
    // Name key must NOT exist when alias is present
    expect(result!.tables["upstream_a"]).toBeUndefined()
  })

  test("skips upstream models with empty columns", () => {
    const result = buildSchemaContext(nodes, sources, ["model.project.upstream_b"])
    expect(result).toBeNull()
  })

  test("resolves upstream IDs from sources", () => {
    const result = buildSchemaContext(nodes, sources, ["source.project.raw.events"])
    expect(result).not.toBeNull()
    expect(result!.tables["events"]).toBeDefined()
    expect(result!.tables["events"].columns).toEqual([
      { name: "event_id", type: "BIGINT" },
    ])
  })

  test("returns null when no upstream IDs provided", () => {
    expect(buildSchemaContext(nodes, sources, [])).toBeNull()
  })

  test("returns null when upstream IDs do not resolve", () => {
    expect(buildSchemaContext(nodes, sources, ["model.project.ghost"])).toBeNull()
  })
})

// ---------- extractColumns ----------

describe("extractColumns", () => {
  test("extracts column with data_type and description", () => {
    const dict = {
      id: { name: "id", data_type: "INTEGER", description: "Primary key" },
    }
    const cols = extractColumns(dict)
    expect(cols).toHaveLength(1)
    expect(cols[0]).toEqual({ name: "id", data_type: "INTEGER", description: "Primary key" })
  })

  test("falls back to 'type' field when data_type is missing", () => {
    const dict = {
      name: { name: "name", type: "VARCHAR" },
    }
    const cols = extractColumns(dict)
    expect(cols).toHaveLength(1)
    expect(cols[0].name).toBe("name")
    expect(cols[0].data_type).toBe("VARCHAR")
    expect(cols[0].description).toBeUndefined()
  })

  test("uses dict key as column name when col.name is missing", () => {
    const dict = { amount: { data_type: "DECIMAL" } }
    const cols = extractColumns(dict)
    expect(cols[0].name).toBe("amount")
  })

  test("returns empty array for empty dict", () => {
    expect(extractColumns({})).toEqual([])
  })

  test("handles both name and type fallbacks simultaneously", () => {
    const dict = {
      my_col: { type: "TEXT" },
    }
    const result = extractColumns(dict)
    expect(result[0].name).toBe("my_col")
    expect(result[0].data_type).toBe("TEXT")
    expect(result[0].description).toBeUndefined()
  })
})

// ---------- listModelNames ----------

describe("listModelNames", () => {
  test("returns only model names, excluding sources and tests", () => {
    const nodes: Record<string, any> = {
      "model.p.a": { resource_type: "model", name: "alpha" },
      "source.p.b": { resource_type: "source", name: "beta" },
      "model.p.c": { resource_type: "model", name: "gamma" },
      "test.p.d": { resource_type: "test", name: "delta" },
    }
    const names = listModelNames(nodes)
    expect(names).toEqual(["alpha", "gamma"])
  })

  test("returns empty array for no models", () => {
    expect(listModelNames({})).toEqual([])
  })
})

// ---------- loadRawManifest ----------

describe("loadRawManifest", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbt-helpers-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("returns null for non-existent file", () => {
    expect(loadRawManifest(path.join(tmpDir, "nonexistent.json"))).toBeNull()
  })

  test("parses valid manifest file", () => {
    const manifestPath = path.join(tmpDir, "manifest.json")
    fs.writeFileSync(manifestPath, JSON.stringify({ nodes: {}, metadata: { adapter_type: "snowflake" } }))
    const result = loadRawManifest(manifestPath)
    expect(result).not.toBeNull()
    expect(result.metadata.adapter_type).toBe("snowflake")
  })

  test("throws on invalid JSON", () => {
    const manifestPath = path.join(tmpDir, "bad.json")
    fs.writeFileSync(manifestPath, "not json {{{")
    expect(() => loadRawManifest(manifestPath)).toThrow()
  })

  test("throws when manifest is a primitive (not an object)", () => {
    // typeof 42 === "number", triggers the non-object guard
    const manifestPath = path.join(tmpDir, "number.json")
    fs.writeFileSync(manifestPath, "42")
    expect(() => loadRawManifest(manifestPath)).toThrow("Manifest is not a JSON object")
  })

  test("caches by path+mtime (same reference returned)", () => {
    const manifestPath = path.join(tmpDir, "cached.json")
    fs.writeFileSync(manifestPath, JSON.stringify({ v: 1 }))
    const first = loadRawManifest(manifestPath)
    const second = loadRawManifest(manifestPath)
    // Same object reference from cache
    expect(first).toBe(second)
  })

  test("invalidates cache when file content is rewritten", () => {
    const manifestPath = path.join(tmpDir, "updated.json")
    fs.writeFileSync(manifestPath, JSON.stringify({ v: 1 }))
    const first = loadRawManifest(manifestPath)

    // Rewrite with bumped mtime to guarantee cache invalidation.
    // Some filesystems have 1-second mtime granularity, so we
    // explicitly set a future mtime.
    fs.writeFileSync(manifestPath, JSON.stringify({ v: 2 }))
    const futureMs = Date.now() / 1000 + 5
    fs.utimesSync(manifestPath, futureMs, futureMs)
    const second = loadRawManifest(manifestPath)
    expect(second.v).toBe(2)
  })

  test("does not throw for JSON array (typeof [] is 'object')", () => {
    // typeof [] === "object" in JS, so arrays pass the guard.
    // Known edge case — callers handle gracefully since .nodes is undefined on arrays.
    const manifestPath = path.join(tmpDir, "array-manifest.json")
    fs.writeFileSync(manifestPath, "[1, 2, 3]")
    const result = loadRawManifest(manifestPath)
    expect(Array.isArray(result)).toBe(true)
  })

  test("resolves symlinks before caching", () => {
    const realPath = path.join(tmpDir, "real-manifest.json")
    const symPath = path.join(tmpDir, "link-manifest.json")
    const data = { metadata: {}, nodes: { sym: true } }
    fs.writeFileSync(realPath, JSON.stringify(data))
    fs.symlinkSync(realPath, symPath)

    const viaReal = loadRawManifest(realPath)
    const viaSym = loadRawManifest(symPath)
    expect(viaSym).toBe(viaReal)
    expect(viaSym.nodes.sym).toBe(true)
  })
})
