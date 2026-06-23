import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { createDispatcherRunner } from "../../src/altimate/review/runner"
import { Dispatcher } from "../../src/altimate/native"
import { tmpdir } from "../fixture/fixture"

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
