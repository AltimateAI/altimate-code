import { describe, test, expect, mock } from "bun:test"
import { build } from "../src/commands/build"
import type { DBTProjectIntegrationAdapter } from "@altimateai/dbt-integration"

function makeAdapter(overrides: Partial<DBTProjectIntegrationAdapter> = {}): DBTProjectIntegrationAdapter {
  return {
    unsafeBuildModelImmediately: mock(() => Promise.resolve({ stdout: "model built", stderr: "" })),
    unsafeBuildProjectImmediately: mock(() => Promise.resolve({ stdout: "project built", stderr: "" })),
    unsafeRunModelImmediately: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
    unsafeRunModelTestImmediately: mock(() => Promise.resolve({ stdout: "", stderr: "" })),
    // Auto-trigger after `build --model X` calls schema-verify too. Mock its
    // dependencies so the test exercises the build path without erroring on
    // missing adapter methods.
    parseManifest: mock(() => Promise.resolve({
      nodeMetaMap: { lookupByBaseName: mock(() => undefined), lookupByUniqueId: mock(() => undefined), nodes: mock(() => []) },
    })),
    getColumnsOfModel: mock(() => Promise.resolve([])),
    dispose: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as DBTProjectIntegrationAdapter
}

describe("build command", () => {
  test("build without --model builds entire project and reports schema-verify summary", async () => {
    const adapter = makeAdapter()
    const result = await build(adapter, [])
    expect(adapter.unsafeBuildProjectImmediately).toHaveBeenCalledTimes(1)
    expect(adapter.unsafeBuildModelImmediately).not.toHaveBeenCalled()
    // After a project-wide build, schema-verify is auto-run against every
    // model with declared columns (none in this empty-mock case).
    expect((result as Record<string, unknown>).stdout).toBe("project built")
    expect((result as Record<string, unknown>).schema_verify_summary).toBeDefined()
    const summary = (result as unknown as { schema_verify_summary: { models_checked: number } }).schema_verify_summary
    expect(summary.models_checked).toBe(0) // empty manifest in the mock
  })

  test("build --model <name> builds single model and auto-runs schema-verify", async () => {
    const adapter = makeAdapter()
    const result = await build(adapter, ["--model", "orders"])
    expect(adapter.unsafeBuildModelImmediately).toHaveBeenCalledTimes(1)
    expect(adapter.unsafeBuildModelImmediately).toHaveBeenCalledWith({
      plusOperatorLeft: "",
      modelName: "orders",
      plusOperatorRight: "",
    })
    expect(adapter.unsafeBuildProjectImmediately).not.toHaveBeenCalled()
    // After a successful single-model build, schema-verify is auto-run and
    // its result appears under `schema_verify`. The agent cannot see a green
    // build without also seeing the shape diff.
    expect(adapter.parseManifest).toHaveBeenCalledTimes(1)
    expect((result as Record<string, unknown>).stdout).toBe("model built")
    expect((result as Record<string, unknown>).schema_verify).toBeDefined()
  })

  test("build --model <name> --downstream sets plusOperatorRight", async () => {
    const adapter = makeAdapter()
    await build(adapter, ["--model", "orders", "--downstream"])
    expect(adapter.unsafeBuildModelImmediately).toHaveBeenCalledWith({
      plusOperatorLeft: "",
      modelName: "orders",
      plusOperatorRight: "+",
    })
  })

  test("build --downstream without --model returns error", async () => {
    const adapter = makeAdapter()
    const result = await build(adapter, ["--downstream"])
    expect(result).toEqual({ error: "--downstream requires --model" })
    expect(adapter.unsafeBuildProjectImmediately).not.toHaveBeenCalled()
    expect(adapter.unsafeBuildModelImmediately).not.toHaveBeenCalled()
  })

  test("project-wide build collects per-model schema-verify mismatches", async () => {
    // Mock manifest with 3 models: one matching spec, one mismatch (extra col), one no-spec.
    const matchingNode = {
      resource_type: "model",
      name: "users_dim",
      columns: { id: { name: "id", description: "", data_type: "INT" } },
    }
    const mismatchNode = {
      resource_type: "model",
      name: "products_dim",
      columns: { id: { name: "id", description: "", data_type: "INT" } },
    }
    const nospecNode = { resource_type: "model", name: "legacy_facts", columns: {} }
    const nodes = [matchingNode, mismatchNode, nospecNode]

    const adapter = makeAdapter({
      parseManifest: mock(() => Promise.resolve({
        nodeMetaMap: {
          lookupByBaseName: mock((name: string) => nodes.find((n) => n.name === name)),
          lookupByUniqueId: mock(() => undefined),
          nodes: mock(() => nodes[Symbol.iterator]()),
        },
      } as never)),
      getColumnsOfModel: mock((modelName: string) => {
        if (modelName === "users_dim") return Promise.resolve([{ column: "id", dtype: "INT" }])
        if (modelName === "products_dim")
          return Promise.resolve([{ column: "id", dtype: "INT" }, { column: "extra_col", dtype: "STRING" }])
        return Promise.resolve([{ column: "anything", dtype: "STRING" }])
      }),
    })

    const result = await build(adapter, [])
    const summary = (result as unknown as { schema_verify_summary: {
      models_checked: number; match: number; mismatch: number; no_spec: number; errored: number;
      mismatches: Array<{ model: string; columns_extra: string[] }>
    } }).schema_verify_summary

    expect(summary.models_checked).toBe(2) // users_dim + products_dim (no_spec is skipped from the per-model verify list)
    expect(summary.match).toBe(1)
    expect(summary.mismatch).toBe(1)
    expect(summary.no_spec).toBe(1)
    expect(summary.errored).toBe(0)
    expect(summary.mismatches[0]?.model).toBe("products_dim")
    expect(summary.mismatches[0]?.columns_extra).toContain("extra_col")
  })

  test("build surfaces stderr as error", async () => {
    const adapter = makeAdapter({
      unsafeBuildProjectImmediately: mock(() =>
        Promise.resolve({ stdout: "partial output", stderr: "compilation error", fullOutput: "" }),
      ),
    })
    const result = await build(adapter, [])
    expect(result).toEqual({ error: "compilation error", stdout: "partial output" })
  })
})
