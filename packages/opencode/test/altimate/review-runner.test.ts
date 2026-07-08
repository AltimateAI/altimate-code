import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { createDispatcherRunner } from "../../src/altimate/review/runner"
import { Dispatcher } from "../../src/altimate/native"
import { tmpdir } from "../fixture/fixture"
import type { GeneratedTest } from "../../src/altimate/review/spec-test-gen"

let dispatcherSpy: ReturnType<typeof spyOn> | undefined

afterEach(() => {
  dispatcherSpy?.mockRestore()
  dispatcherSpy = undefined
})

describe("review manifest loading", () => {
  test("loads a valid manifest without initializing the native dispatcher", async () => {
    await using tmp = await tmpdir()
    const manifestPath = path.join(tmp.path, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        metadata: { adapter_type: "duckdb" },
        nodes: {
          "model.demo.orders": {
            resource_type: "model",
            name: "orders",
            original_file_path: "models/orders.sql",
            config: { materialized: "table" },
            depends_on: { nodes: [] },
            columns: {},
          },
        },
        sources: {},
      }),
    )

    const runner = createDispatcherRunner({ manifestPath })
    expect(await runner.manifestAvailable?.()).toBe(true)
    expect(await runner.impact("orders")).toEqual({
      hasManifest: true,
      severity: "SAFE",
      directCount: 0,
      transitiveCount: 0,
      testCount: 0,
    })
  })

  test("threads adapter dialect into core equivalence", async () => {
    await using tmp = await tmpdir()
    const manifestPath = path.join(tmp.path, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        metadata: { adapter_type: "duckdb" },
        nodes: {
          "model.demo.orders": {
            resource_type: "model",
            name: "orders",
            original_file_path: "models/orders.sql",
            config: { materialized: "table" },
            depends_on: { nodes: [] },
            columns: { id: { name: "id", data_type: "integer" } },
          },
        },
        sources: {},
      }),
    )

    let seenParams: any
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation((async (method: string, params: any) => {
      expect(method).toBe("altimate_core.equivalence")
      seenParams = params
      return {
        success: true,
        data: {
          equivalent: true,
          confidence: 0.95,
          differences: [],
          validation_errors: [],
        },
      }
    }) as any)

    const runner = createDispatcherRunner({ manifestPath })
    const result = await runner.equivalence("select id from orders", "select id from orders", "duckdb")

    expect(result).toEqual({ decided: true, equivalent: true, differences: [], confidence: "high" })
    expect(seenParams.dialect).toBe("duckdb")
  })
})

describe("runner honors engine `decidable` flag (core 0.5.1)", () => {
  // Manifest with a typed column so resolveSchema() yields a non-null schema
  // (the runner abstains when no schema is available, independent of decidable).
  async function runnerWithManifest() {
    const tmp = await tmpdir()
    const manifestPath = path.join(tmp.path, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        metadata: { adapter_type: "duckdb" },
        nodes: {
          "model.demo.orders": {
            resource_type: "model",
            name: "orders",
            original_file_path: "models/orders.sql",
            config: { materialized: "table" },
            depends_on: { nodes: [] },
            columns: { id: { name: "id", data_type: "integer" } },
          },
        },
        sources: {},
      }),
    )
    return { tmp, runner: createDispatcherRunner({ manifestPath }) }
  }

  function mockEquivalence(data: Record<string, any>) {
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation((async () => ({
      success: true,
      data,
    })) as any)
  }

  test("decidable=false with NO validation errors → abstains (decided:false)", async () => {
    const { tmp, runner } = await runnerWithManifest()
    // The engine says equivalent=true but flags the comparison as not decidable.
    // We must NOT clear the change as safe on an authoritative abstention.
    mockEquivalence({ equivalent: true, confidence: 0.95, differences: [], validation_errors: [], decidable: false })
    const result = await runner.equivalence("select id from orders", "select id from orders", "duckdb")
    expect(result).toEqual({ decided: false })
    await tmp[Symbol.asyncDispose]?.()
  })

  test("decidable=true → decided verdict is returned", async () => {
    const { tmp, runner } = await runnerWithManifest()
    mockEquivalence({ equivalent: true, confidence: 0.95, differences: [], validation_errors: [], decidable: true })
    const result = await runner.equivalence("select id from orders", "select id from orders", "duckdb")
    expect(result).toEqual({ decided: true, equivalent: true, differences: [], confidence: "high" })
    await tmp[Symbol.asyncDispose]?.()
  })

  test("decidable absent (0.4.0 legacy shape) → still decided (backward compatible)", async () => {
    const { tmp, runner } = await runnerWithManifest()
    mockEquivalence({ equivalent: true, confidence: 0.95, differences: [], validation_errors: [] })
    const result = await runner.equivalence("select id from orders", "select id from orders", "duckdb")
    expect(result).toEqual({ decided: true, equivalent: true, differences: [], confidence: "high" })
    await tmp[Symbol.asyncDispose]?.()
  })

  test("decidable=false overrides even a non-equivalent verdict (no false block)", async () => {
    const { tmp, runner } = await runnerWithManifest()
    mockEquivalence({
      equivalent: false,
      confidence: 0.5,
      differences: [{ description: "maybe changed", severity: "semantic" }],
      validation_errors: [],
      decidable: false,
    })
    const result = await runner.equivalence("select id from orders", "select 1 as id from orders", "duckdb")
    expect(result).toEqual({ decided: false })
    await tmp[Symbol.asyncDispose]?.()
  })
})

describe("review runner declared constraints", () => {
  async function runnerWithNodes(nodes: Record<string, any>) {
    const tmp = await tmpdir()
    const manifestPath = path.join(tmp.path, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        metadata: { adapter_type: "duckdb" },
        nodes,
        sources: {},
      }),
    )
    return { tmp, runner: createDispatcherRunner({ manifestPath }) }
  }

  test("model-level primary_key emits composite unique plus not_null per key column", async () => {
    const { tmp, runner } = await runnerWithNodes({
      "model.demo.fct_orders": {
        resource_type: "model",
        name: "fct_orders",
        original_file_path: "models/fct_orders.sql",
        config: { materialized: "table", contract: { enforced: true } },
        depends_on: { nodes: [] },
        columns: {
          customer_id: { name: "customer_id", data_type: "integer" },
          order_id: { name: "order_id", data_type: "integer" },
        },
        constraints: [{ type: "primary_key", columns: ["customer_id", "order_id"] }],
      },
    })

    const constraints = await runner.declaredConstraints?.("fct_orders")
    const executable = constraints?.filter((c) => c.kind !== "column_type") ?? []

    expect(executable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "unique", args: { columns: ["customer_id", "order_id"] } }),
        expect.objectContaining({ kind: "not_null", column: "customer_id" }),
        expect.objectContaining({ kind: "not_null", column: "order_id" }),
      ]),
    )
    await tmp[Symbol.asyncDispose]?.()
  })

  test("keeps distinct model-level unique column sets", async () => {
    const { tmp, runner } = await runnerWithNodes({
      "model.demo.fct_orders": {
        resource_type: "model",
        name: "fct_orders",
        original_file_path: "models/fct_orders.sql",
        config: { materialized: "table", contract: { enforced: true } },
        depends_on: { nodes: [] },
        columns: {
          customer_id: { name: "customer_id", data_type: "integer" },
          order_id: { name: "order_id", data_type: "integer" },
        },
        constraints: [
          { type: "unique", columns: ["customer_id"] },
          { type: "unique", columns: ["order_id"] },
        ],
      },
    })

    const uniques = (await runner.declaredConstraints?.("fct_orders"))?.filter((c) => c.kind === "unique") ?? []

    expect(uniques.map((c) => (c.args?.columns as string[]).join(",")).sort()).toEqual(["customer_id", "order_id"])
    await tmp[Symbol.asyncDispose]?.()
  })
})

describe("review runner generated spec-test sandbox", () => {
  async function runnerWithManifest() {
    const tmp = await tmpdir()
    const manifestPath = path.join(tmp.path, "manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({
        metadata: { adapter_type: "duckdb" },
        nodes: {
          "model.demo.fct_orders": {
            resource_type: "model",
            name: "fct_orders",
            original_file_path: "models/fct_orders.sql",
            config: { materialized: "table" },
            depends_on: { nodes: [] },
            columns: {
              customer_id: { name: "customer_id", data_type: "integer" },
              status: { name: "status", data_type: "text" },
            },
          },
          "model.demo.dim_customers": {
            resource_type: "model",
            name: "dim_customers",
            original_file_path: "models/dim_customers.sql",
            config: { materialized: "table" },
            depends_on: { nodes: [] },
            columns: { customer_id: { name: "customer_id", data_type: "integer" } },
          },
        },
        sources: {},
      }),
    )
    return { tmp, runner: createDispatcherRunner({ manifestPath }) }
  }

  test("rejects track-B relationships when the target relation is not allowlisted", async () => {
    const { tmp, runner } = await runnerWithManifest()
    let calls = 0
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation((async () => {
      calls++
      return { rows: [[0]] }
    }) as any)
    const test: GeneratedTest = {
      id: "rel-track-b",
      kind: "relationships",
      dbtTest: {
        column: "customer_id",
        test: "relationships",
        args: { to: "ref('dim_customers')", field: "customer_id" },
      },
      rationale: "soft inferred relationship",
      derivedFrom: { origin: "inferred_context", kind: "ref_edge", ref: "ref:dim_customers", text: "dim_customers" },
    }

    const results = await runner.runGeneratedTests?.([test], undefined, {
      model: "fct_orders",
      allowedRelations: ["fct_orders"],
    })

    expect(results?.[test.id]?.status).toBe("error")
    expect(results?.[test.id]?.detail).toContain("sandbox")
    expect(calls).toBe(0)
    await tmp[Symbol.asyncDispose]?.()
  })

  test("rejects track-B accepted_values when the checked relation is not allowlisted", async () => {
    const { tmp, runner } = await runnerWithManifest()
    let calls = 0
    dispatcherSpy = spyOn(Dispatcher, "call").mockImplementation((async () => {
      calls++
      return { rows: [[0]] }
    }) as any)
    const test: GeneratedTest = {
      id: "accepted-track-b",
      kind: "accepted_values",
      dbtTest: { column: "status", test: "accepted_values", args: { values: ["placed", "shipped"] } },
      rationale: "soft inferred values",
      derivedFrom: {
        origin: "inferred_context",
        kind: "schema_desc",
        ref: "schema.yml:fct_orders.status:description",
        text: "known status values",
      },
    }

    const results = await runner.runGeneratedTests?.([test], undefined, { allowedRelations: ["dim_customers"] })

    expect(results?.[test.id]?.status).toBe("error")
    expect(results?.[test.id]?.detail).toContain("sandbox")
    expect(calls).toBe(0)
    await tmp[Symbol.asyncDispose]?.()
  })
})
