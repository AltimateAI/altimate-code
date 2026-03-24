import { describe, test, expect } from "bun:test"
import { findDownstream, formatImpactReport } from "../../../src/altimate/tools/impact-analysis"
import type { DownstreamModel } from "../../../src/altimate/tools/impact-analysis"

describe("findDownstream: DAG traversal", () => {
  test("returns empty for leaf model with no dependents", () => {
    const models = [
      { name: "stg_orders", depends_on: ["source.raw_orders"], materialized: "view" },
      { name: "stg_customers", depends_on: ["source.raw_customers"], materialized: "view" },
    ]
    const result = findDownstream("stg_orders", models)
    expect(result).toHaveLength(0)
  })

  test("finds direct dependents (depth 1)", () => {
    const models = [
      { name: "stg_orders", depends_on: ["source.raw_orders"] },
      { name: "fct_orders", depends_on: ["project.stg_orders", "project.stg_customers"] },
      { name: "stg_customers", depends_on: ["source.raw_customers"] },
    ]
    const result = findDownstream("stg_orders", models)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("fct_orders")
    expect(result[0].depth).toBe(1)
  })

  test("finds transitive dependents across multiple depths", () => {
    const models = [
      { name: "stg_orders", depends_on: ["source.raw_orders"] },
      { name: "fct_orders", depends_on: ["project.stg_orders"] },
      { name: "dim_orders", depends_on: ["project.fct_orders"] },
      { name: "report_orders", depends_on: ["project.dim_orders"] },
    ]
    const result = findDownstream("stg_orders", models)
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ name: "fct_orders", depth: 1 })
    expect(result[1]).toMatchObject({ name: "dim_orders", depth: 2 })
    expect(result[2]).toMatchObject({ name: "report_orders", depth: 3 })
  })

  test("tracks dependency paths correctly", () => {
    const models = [
      { name: "stg_orders", depends_on: [] as string[] },
      { name: "fct_orders", depends_on: ["project.stg_orders"] },
      { name: "report", depends_on: ["project.fct_orders"] },
    ]
    const result = findDownstream("stg_orders", models)
    expect(result[0].path).toEqual(["stg_orders", "fct_orders"])
    expect(result[1].path).toEqual(["stg_orders", "fct_orders", "report"])
  })

  test("handles diamond dependency (A\u2192B, A\u2192C, B\u2192D, C\u2192D)", () => {
    const models = [
      { name: "A", depends_on: [] as string[] },
      { name: "B", depends_on: ["project.A"] },
      { name: "C", depends_on: ["project.A"] },
      { name: "D", depends_on: ["project.B", "project.C"] },
    ]
    const result = findDownstream("A", models)
    // D should appear only once (visited set prevents duplicates)
    const names = result.map((r) => r.name)
    expect(names.filter((n) => n === "D")).toHaveLength(1)
    expect(result).toHaveLength(3) // B, C, D
  })

  test("self-referencing model \u2014 behavior documentation only, not a valid dbt graph", () => {
    const models = [
      { name: "stg_orders", depends_on: ["project.stg_orders"] },
    ]
    // This assertion exists only to document current behavior, not to endorse it.
    // Self-referencing dbt models are invalid and cannot compile, so this edge case
    // is not reachable in practice. The visited set prevents infinite recursion.
    const result = findDownstream("stg_orders", models)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("stg_orders")
  })

  test("parses qualified names (strips prefix before last dot)", () => {
    const models = [
      { name: "stg_orders", depends_on: [] as string[] },
      { name: "fct_orders", depends_on: ["my_project.stg_orders", "other_project.stg_customers"] },
    ]
    const result = findDownstream("stg_orders", models)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("fct_orders")
  })

  test("preserves materialization metadata", () => {
    const models = [
      { name: "stg_orders", depends_on: [] as string[], materialized: "view" },
      { name: "fct_orders", depends_on: ["project.stg_orders"], materialized: "table" },
      { name: "report", depends_on: ["project.fct_orders"], materialized: "incremental" },
    ]
    const result = findDownstream("stg_orders", models)
    expect(result[0].materialized).toBe("table")
    expect(result[1].materialized).toBe("incremental")
  })

  test("model not in graph returns empty", () => {
    const models = [
      { name: "stg_orders", depends_on: ["source.raw_orders"] },
      { name: "fct_orders", depends_on: ["project.stg_orders"] },
    ]
    const result = findDownstream("nonexistent_model", models)
    expect(result).toHaveLength(0)
  })
})

describe("formatImpactReport", () => {
  test("safe change with zero downstream", () => {
    const report = formatImpactReport({
      model: "stg_temp",
      changeType: "remove",
      direct: [],
      transitive: [],
      affectedTestCount: 0,
      columnImpact: [],
      totalModels: 10,
    })
    expect(report).toContain("REMOVE stg_temp")
    expect(report).toContain("Blast radius: 0/10 models (0.0%)")
    expect(report).toContain("No downstream models depend on this. Change is safe to make.")
    expect(report).not.toContain("WARNING")
  })

  test("remove with downstream shows BREAKING warning", () => {
    const report = formatImpactReport({
      model: "stg_orders",
      changeType: "remove",
      direct: [{ name: "fct_orders", depth: 1, path: ["stg_orders", "fct_orders"] }],
      transitive: [],
      affectedTestCount: 0,
      columnImpact: [],
      totalModels: 20,
    })
    expect(report).toContain("WARNING: This is a BREAKING change")
    expect(report).toContain("Blast radius: 1/20 models (5.0%)")
    expect(report).toContain("Direct Dependents (1)")
    expect(report).toContain("Consider deprecation period before removal")
  })

  test("rename shows rename-specific warning and actions", () => {
    const report = formatImpactReport({
      model: "stg_orders",
      changeType: "rename",
      direct: [{ name: "fct_orders", depth: 1, path: ["stg_orders", "fct_orders"] }],
      transitive: [],
      affectedTestCount: 5,
      columnImpact: [],
      totalModels: 10,
    })
    expect(report).toContain("WARNING: Rename requires updating all downstream references.")
    expect(report).toContain("Update all downstream SQL references to new name")
    expect(report).toContain("Tests in project: 5")
  })

  test("column-level impact shows affected columns", () => {
    const report = formatImpactReport({
      model: "stg_orders",
      column: "order_id",
      changeType: "retype",
      direct: [{ name: "fct_orders", depth: 1, path: ["stg_orders", "fct_orders"] }],
      transitive: [],
      affectedTestCount: 0,
      columnImpact: ["total_amount", "order_count"],
      totalModels: 10,
    })
    expect(report).toContain("RETYPE stg_orders.order_id")
    expect(report).toContain("CAUTION: Type change may cause implicit casts")
    expect(report).toContain("Affected Output Columns (2)")
    expect(report).toContain("total_amount")
    expect(report).toContain("order_count")
  })

  test("percentage calculation with 0 total models does not produce NaN or Infinity", () => {
    const report = formatImpactReport({
      model: "stg_orders",
      changeType: "add",
      direct: [],
      transitive: [],
      affectedTestCount: 0,
      columnImpact: [],
      totalModels: 0,
    })
    expect(report).not.toContain("NaN")
    expect(report).not.toContain("Infinity")
    expect(report).toContain("Blast radius: 0/0 models")
  })

  test("transitive dependents show dependency path", () => {
    const report = formatImpactReport({
      model: "stg_orders",
      changeType: "modify",
      direct: [{ name: "fct_orders", depth: 1, path: ["stg_orders", "fct_orders"] }],
      transitive: [{ name: "report", depth: 2, materialized: "table", path: ["stg_orders", "fct_orders", "report"] }],
      affectedTestCount: 0,
      columnImpact: [],
      totalModels: 50,
    })
    expect(report).toContain("Direct Dependents (1)")
    expect(report).toContain("Transitive Dependents (1)")
    expect(report).toContain("report [table] (via: stg_orders \u2192 fct_orders \u2192 report)")
    expect(report).toContain("Blast radius: 2/50 models (4.0%)")
  })
})
