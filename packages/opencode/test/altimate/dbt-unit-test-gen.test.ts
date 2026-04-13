import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"
import YAML from "yaml"
import { tmpdir } from "../fixture/fixture"
import { generateDbtUnitTests, assembleYaml } from "../../src/altimate/native/dbt/unit-tests"
import type { UnitTestCase } from "../../src/altimate/native/types"

// ---------------------------------------------------------------------------
// Helpers — each test uses `await using tmp = await tmpdir()` for its own
// disposable tmpdir. No suite-level state.
// ---------------------------------------------------------------------------

/** Write a manifest JSON into the given tmp dir and return its absolute path. */
function writeManifestTo(dirPath: string, content: object | string): string {
  const p = path.join(dirPath, "manifest.json")
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content))
  return p
}

function makeManifest(overrides?: {
  modelName?: string; materialized?: string; compiledSql?: string
  modelColumns?: Record<string, any>; upstreamName?: string
  upstreamColumns?: Record<string, any>; upstreamMaterialized?: string
  adapterType?: string; sources?: Record<string, any>
}) {
  const o = overrides || {}
  const modelName = o.modelName ?? "fct_orders"
  const upstreamName = o.upstreamName ?? "stg_orders"
  const proj = "my_project"
  return {
    metadata: { dbt_version: "1.8.0", adapter_type: o.adapterType ?? "snowflake" },
    nodes: {
      [`model.${proj}.${modelName}`]: {
        resource_type: "model", name: modelName, schema: "analytics",
        config: { materialized: o.materialized ?? "table" },
        depends_on: { nodes: [`model.${proj}.${upstreamName}`] },
        columns: o.modelColumns ?? {
          order_id: { name: "order_id", data_type: "INTEGER" },
          order_total: { name: "order_total", data_type: "NUMERIC" },
        },
        compiled_code: o.compiledSql ?? `SELECT order_id, quantity * unit_price AS order_total FROM ${upstreamName}`,
      },
      [`model.${proj}.${upstreamName}`]: {
        resource_type: "model", name: upstreamName, schema: "staging",
        config: { materialized: o.upstreamMaterialized ?? "view" },
        depends_on: { nodes: [] },
        columns: o.upstreamColumns ?? {
          order_id: { name: "order_id", data_type: "INTEGER" },
          quantity: { name: "quantity", data_type: "INTEGER" },
          unit_price: { name: "unit_price", data_type: "NUMERIC" },
        },
      },
    },
    sources: o.sources ?? {},
  }
}

// ---------------------------------------------------------------------------
// generateDbtUnitTests
// ---------------------------------------------------------------------------

describe("generateDbtUnitTests", () => {
  test("returns error when manifest file does not exist", async () => {
    const r = await generateDbtUnitTests({ manifest_path: "/tmp/nonexistent.json", model: "fct_orders" })
    expect(r.success).toBe(false)
    expect(r.error).toContain("Manifest file not found")
  })

  test("returns error when model not found", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, makeManifest()), model: "nope" })
    expect(r.success).toBe(false)
    expect(r.error).toContain("not found in manifest")
  })

  test("returns error when compiled SQL is missing", async () => {
    await using tmp = await tmpdir()
    const m = makeManifest({ compiledSql: "" })
    const key = Object.keys(m.nodes).find((k) => k.includes("fct_orders"))!
    ;(m.nodes as any)[key].compiled_code = ""
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, m), model: "fct_orders" })
    expect(r.success).toBe(false)
    expect(r.error).toContain("No compiled SQL found")
  })

  test("generates happy path test for simple model", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, makeManifest()), model: "fct_orders" })
    expect(r.success).toBe(true)
    expect(r.model_name).toBe("fct_orders")
    expect(r.materialized).toBe("table")
    expect(r.dependency_count).toBe(1)
    expect(r.tests.length).toBeGreaterThanOrEqual(1)
    expect(r.tests[0].category).toBe("happy_path")
    expect(r.tests[0].given.length).toBe(1)
    expect(r.tests[0].given[0].input).toBe("ref('stg_orders')")
    expect(r.tests[0].given[0].rows.length).toBeGreaterThan(0)
  })

  test("YAML output is valid and parseable", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, makeManifest()), model: "fct_orders" })
    expect(r.yaml).toBeTruthy()
    // Round-trip: parse the generated YAML and verify structure
    const parsed = YAML.parse(r.yaml)
    expect(parsed.unit_tests).toBeArray()
    expect(parsed.unit_tests[0].name).toContain("fct_orders")
    expect(parsed.unit_tests[0].model).toBe("fct_orders")
    expect(parsed.unit_tests[0].given).toBeArray()
    expect(parsed.unit_tests[0].expect.rows).toBeArray()
  })

  test("detects CASE/WHEN and generates null_handling test", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({
        compiledSql: `SELECT order_id, CASE WHEN status = 'done' THEN amount ELSE 0 END AS net FROM stg_orders`,
      })),
      model: "fct_orders",
    })
    expect(r.success).toBe(true)
    expect(r.tests.length).toBeGreaterThan(1)
    expect(r.tests.map((t) => t.category)).toContain("null_handling")
  })

  test("detects division and generates boundary test", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({
        compiledSql: `SELECT order_id, amount / quantity AS unit_price FROM stg_orders`,
      })),
      model: "fct_orders",
    })
    expect(r.success).toBe(true)
    expect(r.tests.map((t) => t.category)).toContain("edge_case")
  })

  test("generates incremental test with input: this mock", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({ materialized: "incremental" })),
      model: "fct_orders",
      max_scenarios: 5,
    })
    expect(r.success).toBe(true)
    const inc = r.tests.find((t) => t.category === "incremental")
    expect(inc).toBeDefined()
    expect(inc!.overrides?.macros?.is_incremental).toBe(true)
    // Must include input: this for existing table state
    const thisInput = inc!.given.find((g) => g.input === "this")
    expect(thisInput).toBeDefined()
    expect(thisInput!.rows.length).toBeGreaterThan(0)
  })

  test("ephemeral deps with no columns use sql format, not dict", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({
        upstreamMaterialized: "ephemeral",
        upstreamColumns: {}, // no columns known
      })),
      model: "fct_orders",
    })
    expect(r.success).toBe(true)
    // The ephemeral dep should use sql format even with no columns
    const ephInput = r.tests[0].given.find((g) => g.format === "sql")
    expect(ephInput).toBeDefined()
    expect(ephInput!.sql).toBeDefined()
  })

  test("resolves seed dependencies via ref()", async () => {
    await using tmp = await tmpdir()
    const m = makeManifest()
    const key = Object.keys(m.nodes).find((k) => k.includes("fct_orders"))!
    ;(m.nodes as any)[key].depends_on.nodes = ["seed.my_project.country_codes"]
    ;(m.nodes as any)["seed.my_project.country_codes"] = {
      resource_type: "seed",
      name: "country_codes",
      schema: "seeds",
      config: { materialized: "seed" },
      depends_on: { nodes: [] },
      columns: { code: { name: "code", data_type: "VARCHAR" }, name: { name: "name", data_type: "VARCHAR" } },
    }
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, m), model: "fct_orders" })
    expect(r.success).toBe(true)
    expect(r.dependency_count).toBe(1)
    // Seed should resolve as ref(), not source()
    expect(r.tests[0].given[0].input).toBe("ref('country_codes')")
    expect(r.tests[0].given[0].rows.length).toBeGreaterThan(0)
  })

  test("warns when upstream deps cannot be resolved", async () => {
    await using tmp = await tmpdir()
    const m = makeManifest()
    const key = Object.keys(m.nodes).find((k) => k.includes("fct_orders"))!
    // Add an unresolvable dep — semantic_model.* is a real dbt resource type
    // that parseManifest doesn't extract (and we don't support)
    ;(m.nodes as any)[key].depends_on.nodes.push("semantic_model.my_project.orders_sm")
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, m), model: "fct_orders" })
    expect(r.success).toBe(true)
    expect(r.warnings.some((w) => w.includes("Could not resolve") && w.includes("semantic_model"))).toBe(true)
  })

  test("resolves snapshot dependencies via ref()", async () => {
    await using tmp = await tmpdir()
    const m = makeManifest()
    const key = Object.keys(m.nodes).find((k) => k.includes("fct_orders"))!
    ;(m.nodes as any)[key].depends_on.nodes = ["snapshot.my_project.orders_snapshot"]
    ;(m.nodes as any)["snapshot.my_project.orders_snapshot"] = {
      resource_type: "snapshot",
      name: "orders_snapshot",
      schema: "snapshots",
      config: { materialized: "snapshot" },
      depends_on: { nodes: [] },
      columns: { order_id: { name: "order_id", data_type: "INTEGER" }, status: { name: "status", data_type: "VARCHAR" } },
    }
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, m), model: "fct_orders" })
    expect(r.success).toBe(true)
    expect(r.dependency_count).toBe(1)
    expect(r.tests[0].given[0].input).toBe("ref('orders_snapshot')")
    expect(r.tests[0].given[0].rows.length).toBeGreaterThan(0)
  })

  test("long model names preserve scenario suffix (no truncation collision)", async () => {
    await using tmp = await tmpdir()
    // 70-char model name — longer than 64-char test name limit
    const longName = "fct_this_is_a_very_long_model_name_that_will_definitely_exceed_limits"
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({
        modelName: longName,
        compiledSql: `SELECT order_id, CASE WHEN x=1 THEN 'a' END, a/b FROM stg_orders`,
      })),
      model: longName,
      max_scenarios: 5,
    })
    expect(r.success).toBe(true)
    // All test names should be unique — no collisions from truncation
    const names = r.tests.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    // Scenario suffixes should be preserved
    expect(names.some((n) => n.endsWith("_happy_path"))).toBe(true)
    expect(names.some((n) => n.includes("null_handling") || n.includes("edge_case"))).toBe(true)
  })

  test("division in string literals does not trigger boundary scenario", async () => {
    await using tmp = await tmpdir()
    // The SQL has '/' only inside a string literal — should NOT trigger division edge case
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({
        compiledSql: `SELECT order_id, '2024/01/15' AS date_str FROM stg_orders`,
      })),
      model: "fct_orders",
      max_scenarios: 5,
    })
    expect(r.success).toBe(true)
    // Only happy_path should be generated (no division → no boundary test)
    expect(r.tests.length).toBe(1)
    expect(r.tests[0].category).toBe("happy_path")
  })

  test("test names are deterministic across runs", async () => {
    await using tmp = await tmpdir()
    const manifestPath = writeManifestTo(tmp.path, makeManifest({
      compiledSql: `SELECT order_id, CASE WHEN x=1 THEN 'a' ELSE 'b' END, a/b FROM stg_orders`,
    }))
    const r1 = await generateDbtUnitTests({ manifest_path: manifestPath, model: "fct_orders", max_scenarios: 5 })
    const r2 = await generateDbtUnitTests({ manifest_path: manifestPath, model: "fct_orders", max_scenarios: 5 })
    expect(r1.tests.map((t) => t.name)).toEqual(r2.tests.map((t) => t.name))
    expect(r1.yaml).toEqual(r2.yaml)
  })

  test("uses sql format for ephemeral upstream models", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({ upstreamMaterialized: "ephemeral" })),
      model: "fct_orders",
    })
    expect(r.success).toBe(true)
    expect(r.warnings.some((w) => w.includes("ephemeral"))).toBe(true)
    const sqlInput = r.tests[0].given.find((g) => g.format === "sql")
    expect(sqlInput).toBeDefined()
    expect(sqlInput!.sql).toContain("SELECT")
  })

  test("handles source() dependencies", async () => {
    await using tmp = await tmpdir()
    const m = makeManifest()
    const key = Object.keys(m.nodes).find((k) => k.includes("fct_orders"))!
    ;(m.nodes as any)[key].depends_on.nodes = ["source.my_project.raw.orders"]
    m.sources = {
      "source.my_project.raw.orders": {
        name: "orders", source_name: "raw", resource_type: "source", schema: "raw_data",
        columns: { order_id: { name: "order_id", data_type: "INTEGER" } },
      },
    }
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, m), model: "fct_orders" })
    expect(r.success).toBe(true)
    expect(r.tests[0].given.find((g) => g.input.includes("source("))).toBeDefined()
  })

  test("respects max_scenarios", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({
        compiledSql: `SELECT order_id, CASE WHEN x=1 THEN 'a' ELSE 'b' END, amount/qty FROM stg_orders`,
      })),
      model: "fct_orders",
      max_scenarios: 2,
    })
    expect(r.tests.length).toBeLessThanOrEqual(2)
  })

  test("handles multiple upstream dependencies", async () => {
    await using tmp = await tmpdir()
    const m = makeManifest()
    const key = Object.keys(m.nodes).find((k) => k.includes("fct_orders"))!
    ;(m.nodes as any)[key].depends_on.nodes.push("model.my_project.dim_customers")
    ;(m.nodes as any)["model.my_project.dim_customers"] = {
      resource_type: "model", name: "dim_customers",
      config: { materialized: "table" }, depends_on: { nodes: [] },
      columns: { customer_id: { name: "customer_id", data_type: "INTEGER" } },
    }
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, m), model: "fct_orders" })
    expect(r.dependency_count).toBe(2)
    expect(r.tests[0].given.length).toBe(2)
  })

  test("model lookup by unique_id works", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, makeManifest()), model: "model.my_project.fct_orders" })
    expect(r.success).toBe(true)
    expect(r.model_name).toBe("fct_orders")
  })

  test("handles invalid JSON manifest", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, "{{not json}}"), model: "fct_orders" })
    expect(r.success).toBe(false)
  })

  test("test names are valid identifiers and unique", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({
        compiledSql: `SELECT order_id, CASE WHEN x=1 THEN 'a' ELSE 'b' END, a/b FROM stg_orders`,
      })),
      model: "fct_orders",
      max_scenarios: 5,
    })
    for (const t of r.tests) {
      expect(t.name).toMatch(/^[a-z_][a-z0-9_]*$/)
      expect(t.name.length).toBeLessThanOrEqual(64)
    }
    expect(new Set(r.tests.map((t) => t.name)).size).toBe(r.tests.length)
  })
})

// ---------------------------------------------------------------------------
// assembleYaml — round-trip YAML validation
// ---------------------------------------------------------------------------

describe("assembleYaml", () => {
  test("produces parseable YAML with correct structure", () => {
    const tests: UnitTestCase[] = [{
      name: "test_happy", description: "Happy path", category: "happy_path",
      target_logic: "arithmetic",
      given: [{ input: "ref('stg_orders')", rows: [{ order_id: 1, qty: 3, price: 10.0 }] }],
      expect_rows: [{ order_id: 1, total: 30.0 }],
    }]
    const yaml = assembleYaml("fct_orders", tests)
    const parsed = YAML.parse(yaml)
    expect(parsed.unit_tests).toHaveLength(1)
    expect(parsed.unit_tests[0].name).toBe("test_happy")
    expect(parsed.unit_tests[0].model).toBe("fct_orders")
    expect(parsed.unit_tests[0].given[0].input).toBe("ref('stg_orders')")
    expect(parsed.unit_tests[0].given[0].rows[0].order_id).toBe(1)
    expect(parsed.unit_tests[0].expect.rows[0].total).toBe(30.0)
  })

  test("handles ephemeral sql format", () => {
    const tests: UnitTestCase[] = [{
      name: "test_eph", description: "Ephemeral", category: "happy_path",
      target_logic: "passthrough",
      given: [{
        input: "ref('eph')", rows: [], format: "sql",
        sql: "SELECT 1 AS id, 'test' AS name\nUNION ALL\nSELECT 2 AS id, 'other' AS name",
      }],
      expect_rows: [{ id: 1 }],
    }]
    const yaml = assembleYaml("my_model", tests)
    const parsed = YAML.parse(yaml)
    expect(parsed.unit_tests[0].given[0].format).toBe("sql")
    expect(parsed.unit_tests[0].given[0].rows).toContain("SELECT 1 AS id")
  })

  test("handles macro overrides for incremental", () => {
    const tests: UnitTestCase[] = [{
      name: "test_inc", description: "Incremental", category: "incremental",
      target_logic: "incremental",
      given: [{ input: "ref('src')", rows: [{ id: 1 }] }],
      expect_rows: [{ id: 1 }],
      overrides: { macros: { is_incremental: true } },
    }]
    const yaml = assembleYaml("fct", tests)
    const parsed = YAML.parse(yaml)
    expect(parsed.unit_tests[0].overrides.macros.is_incremental).toBe(true)
  })

  test("handles null values", () => {
    const tests: UnitTestCase[] = [{
      name: "test_null", description: "Nulls", category: "null_handling",
      target_logic: "COALESCE",
      given: [{ input: "ref('src')", rows: [{ id: 1, discount: null }] }],
      expect_rows: [{ id: 1, net: 100.0 }],
    }]
    const yaml = assembleYaml("fct", tests)
    const parsed = YAML.parse(yaml)
    expect(parsed.unit_tests[0].given[0].rows[0].discount).toBeNull()
  })

  test("handles date strings correctly", () => {
    const tests: UnitTestCase[] = [{
      name: "test_date", description: "Dates", category: "happy_path",
      target_logic: "date",
      given: [{ input: "ref('src')", rows: [{ id: 1, dt: "2024-01-15", ts: "2024-01-15 10:30:00" }] }],
      expect_rows: [{ id: 1, dt: "2024-01-15" }],
    }]
    const yaml = assembleYaml("fct", tests)
    const parsed = YAML.parse(yaml)
    expect(parsed.unit_tests[0].given[0].rows[0].dt).toBe("2024-01-15")
    expect(parsed.unit_tests[0].given[0].rows[0].ts).toBe("2024-01-15 10:30:00")
  })

  test("multiple tests produce valid YAML", () => {
    const tests: UnitTestCase[] = [
      { name: "test_a", description: "A", category: "happy_path", target_logic: "x",
        given: [{ input: "ref('s')", rows: [{ id: 1 }] }], expect_rows: [{ id: 1 }] },
      { name: "test_b", description: "B", category: "edge_case", target_logic: "y",
        given: [{ input: "ref('s')", rows: [{ id: 0 }] }], expect_rows: [{ id: 0 }] },
    ]
    const yaml = assembleYaml("m", tests)
    const parsed = YAML.parse(yaml)
    expect(parsed.unit_tests).toHaveLength(2)
  })

  test("empty tests array", () => {
    const yaml = assembleYaml("m", [])
    const parsed = YAML.parse(yaml)
    expect(parsed.unit_tests).toEqual([])
  })

  test("booleans and var overrides", () => {
    const tests: UnitTestCase[] = [{
      name: "test_vars", description: "Vars", category: "happy_path", target_logic: "x",
      given: [{ input: "ref('s')", rows: [{ id: 1, active: true, deleted: false }] }],
      expect_rows: [{ id: 1 }],
      overrides: { vars: { run_date: "2024-01-15", lookback: 30 } },
    }]
    const yaml = assembleYaml("m", tests)
    const parsed = YAML.parse(yaml)
    expect(parsed.unit_tests[0].given[0].rows[0].active).toBe(true)
    expect(parsed.unit_tests[0].given[0].rows[0].deleted).toBe(false)
    expect(parsed.unit_tests[0].overrides.vars.run_date).toBe("2024-01-15")
    expect(parsed.unit_tests[0].overrides.vars.lookback).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// Context: descriptions and lineage
// ---------------------------------------------------------------------------

describe("context: descriptions and lineage", () => {
  test("includes model description", async () => {
    await using tmp = await tmpdir()
    const m = makeManifest()
    const key = Object.keys(m.nodes).find((k) => k.includes("fct_orders"))!
    ;(m.nodes as any)[key].description = "Daily order totals"
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, m), model: "fct_orders" })
    expect(r.context?.model_description).toBe("Daily order totals")
  })

  test("includes upstream descriptions", async () => {
    await using tmp = await tmpdir()
    const m = makeManifest()
    const key = Object.keys(m.nodes).find((k) => k.includes("stg_orders"))!
    ;(m.nodes as any)[key].description = "Staged orders"
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, m), model: "fct_orders" })
    expect(r.context?.upstream[0].description).toBe("Staged orders")
    expect(r.context?.upstream[0].ref).toBe("ref('stg_orders')")
  })

  test("includes column descriptions", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({
        upstreamColumns: {
          order_id: { name: "order_id", data_type: "INTEGER", description: "PK" },
          unit_price: { name: "unit_price", data_type: "NUMERIC", description: "USD price" },
        },
        modelColumns: {
          order_id: { name: "order_id", data_type: "INTEGER" },
          order_total: { name: "order_total", data_type: "NUMERIC", description: "qty * price" },
        },
      })),
      model: "fct_orders",
    })
    expect(r.context?.upstream[0].columns.find((c) => c.name === "unit_price")?.description).toBe("USD price")
    expect(r.context?.output_columns.find((c) => c.name === "order_total")?.description).toBe("qty * price")
  })

  test("includes compiled SQL", async () => {
    await using tmp = await tmpdir()
    const sql = "SELECT order_id, quantity * unit_price AS order_total FROM stg_orders"
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({ compiledSql: sql })),
      model: "fct_orders",
    })
    expect(r.context?.compiled_sql).toBe(sql)
  })

  test("source deps use source() ref format", async () => {
    await using tmp = await tmpdir()
    const m = makeManifest()
    const key = Object.keys(m.nodes).find((k) => k.includes("fct_orders"))!
    ;(m.nodes as any)[key].depends_on.nodes = ["source.my_project.raw.orders"]
    m.sources = {
      "source.my_project.raw.orders": {
        name: "orders", source_name: "raw", resource_type: "source",
        description: "Raw Shopify orders", schema: "raw_data",
        columns: { order_id: { name: "order_id", data_type: "INTEGER" } },
      },
    }
    const r = await generateDbtUnitTests({ manifest_path: writeManifestTo(tmp.path, m), model: "fct_orders" })
    expect(r.context?.upstream[0].ref).toBe("source('raw', 'orders')")
    expect(r.context?.upstream[0].description).toBe("Raw Shopify orders")
  })
})

// ---------------------------------------------------------------------------
// Mock data type handling
// ---------------------------------------------------------------------------

describe("mock data type handling", () => {
  test("generates correct types for various columns", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({
        upstreamColumns: {
          id: { name: "id", data_type: "INTEGER" },
          name: { name: "name", data_type: "VARCHAR" },
          active: { name: "active", data_type: "BOOLEAN" },
          dt: { name: "dt", data_type: "DATE" },
          ts: { name: "ts", data_type: "TIMESTAMP" },
          score: { name: "score", data_type: "FLOAT" },
        },
      })),
      model: "fct_orders",
    })
    const row = r.tests[0].given[0].rows[0]
    expect(typeof row.id).toBe("number")
    expect(Number.isInteger(row.id)).toBe(true)
    expect(typeof row.name).toBe("string")
    expect(typeof row.active).toBe("boolean")
    expect(typeof row.dt).toBe("string")
    expect(typeof row.ts).toBe("string")
  })

  test("null_edge scenario has nulls in non-key columns", async () => {
    await using tmp = await tmpdir()
    const r = await generateDbtUnitTests({
      manifest_path: writeManifestTo(tmp.path, makeManifest({
        compiledSql: `SELECT order_id, COALESCE(discount, 0) AS d FROM stg_orders`,
        upstreamColumns: {
          order_id: { name: "order_id", data_type: "INTEGER" },
          discount: { name: "discount", data_type: "NUMERIC" },
        },
      })),
      model: "fct_orders",
    })
    const nullTest = r.tests.find((t) => t.category === "null_handling")
    if (nullTest) {
      const lastRow = nullTest.given[0].rows[nullTest.given[0].rows.length - 1]
      expect(lastRow.discount).toBeNull()
      expect(lastRow.order_id).not.toBeNull()
    }
  })
})
