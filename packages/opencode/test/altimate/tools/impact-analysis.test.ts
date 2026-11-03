import { describe, test, expect } from "bun:test"
import { findDownstream, formatImpactReport } from "../../../src/altimate/tools/impact-analysis"
import type { DownstreamModel } from "../../../src/altimate/tools/impact-analysis"

describe("findDownstream: depth", () => {
  test("a direct dependent also reachable through another dependent stays direct", () => {
    const models = [
      { name: "y", depends_on: ["model.p.t"] },
      { name: "x", depends_on: ["model.p.y", "model.p.t"] },
    ]
    const result = findDownstream("t", models)
    expect(result.find((d) => d.name === "x")!.depth).toBe(1)
    expect(result.find((d) => d.name === "x")!.path).toEqual(["t", "x"])
  })
})

describe("formatImpactReport: exposures", () => {
  const base = { model: "m", changeType: "remove", direct: [], transitive: [], affectedTestCount: 0, totalModels: 1 }
  test("says when exposures could not be read", () => {
    expect(formatImpactReport({ ...base, exposuresError: "bad json" })).toContain("Exposures: not read (bad json)")
  })
  test("keeps a multi-line read error on one line", () => {
    expect(formatImpactReport({ ...base, exposuresError: "a\nb" })).toContain("Exposures: not read (a b)")
  })
  test("lists a dashboard once when column reach already printed it", () => {
    const dash = { unique_id: "exposure.p.d", name: "d", label: "Dash", type: "dashboard" }
    const out = formatImpactReport({
      ...base,
      column: "c",
      exposures: [dash, { unique_id: "exposure.q.d", name: "d", label: "Other", type: "dashboard" }],
      columnReach: { models: [], uncertain: [], untraced: [], exposures: [dash], uncertain_exposures: [], truncated: false },
    })
    expect(out.match(/Dash \[dashboard\]/g)).toHaveLength(1)
    expect(out).toContain("Other exposures (1)")
    expect(out).toContain("Other [dashboard]")
  })
})

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
      totalModels: 10,
    })
    expect(report).toContain("WARNING: Rename requires updating all downstream references.")
    expect(report).toContain("Update all downstream SQL references to new name")
    expect(report).toContain("Affected tests: 5")
  })

  test("column-level impact names the column and the change", () => {
    const report = formatImpactReport({
      model: "stg_orders",
      column: "order_id",
      changeType: "retype",
      direct: [{ name: "fct_orders", depth: 1, path: ["stg_orders", "fct_orders"] }],
      transitive: [],
      affectedTestCount: 0,
      totalModels: 10,
    })
    expect(report).toContain("RETYPE stg_orders.order_id")
    expect(report).toContain("CAUTION: Type change may cause implicit casts")
  })

  test("column reach lists certain readers, possible readers, untraced models and exposures", () => {
    const report = formatImpactReport({
      model: "fct_orders",
      column: "revenue",
      changeType: "modify",
      direct: [{ name: "fct_daily", depth: 1, path: ["fct_orders", "fct_daily"] }],
      transitive: [],
      affectedTestCount: 0,
      totalModels: 5,
      exposures: [
        { unique_id: "exposure.p.exec", name: "exec", label: "Exec Revenue", type: "dashboard" },
        { unique_id: "exposure.p.far", name: "far", label: "Far Board", type: "dashboard" },
      ],
      columnReach: {
        models: [{ name: "fct_daily", unique_id: "model.p.fct_daily", columns: ["revenue"] }],
        uncertain: [{ name: "rpt_big", unique_id: "model.p.rpt_big", reason: "names it only outside its select list (WHERE, JOIN, GROUP BY or HAVING)" }],
        untraced: [{ name: "mart_ltv", unique_id: "model.p.mart_ltv", reason: "No compiled SQL found — run `dbt compile` first" }],
        exposures: [{ unique_id: "exposure.p.exec", name: "exec", label: "Exec Revenue", type: "dashboard" }],
        uncertain_exposures: [{ unique_id: "exposure.p.ops", name: "ops", label: "Ops", type: "dashboard" }],
        truncated: true,
      },
    })
    expect(report).toContain(
      "Column Reach: fct_orders.revenue is read by at least 1 model and at least 1 exposure; at least 1 more may read it; at least 1 could not be traced (stopped early)",
    )
    expect(report).toContain("  fct_daily → revenue")
    expect(report).toContain("  ◆ Exec Revenue [dashboard]")
    expect(report).toContain("  ? rpt_big: names it only outside its select list (WHERE, JOIN, GROUP BY or HAVING)")
    expect(report).toContain("  ! mart_ltv not traced: No compiled SQL found — run `dbt compile` first")
    expect(report).toContain("  ? ◆ Ops [dashboard] on a model that may read it")
    expect(report).not.toContain("Exposures (")
    // Stopped early: the other exposures are not claimed as non-readers.
    expect(report).toContain("Other exposures (1): column reach stopped early, so some of these were not checked")
  })

  test("percentage calculation with 0 total models does not produce NaN or Infinity", () => {
    const report = formatImpactReport({
      model: "stg_orders",
      changeType: "add",
      direct: [],
      transitive: [],
      affectedTestCount: 0,
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
      totalModels: 50,
    })
    expect(report).toContain("Direct Dependents (1)")
    expect(report).toContain("Transitive Dependents (1)")
    expect(report).toContain("report [table] (via: stg_orders \u2192 fct_orders \u2192 report)")
    expect(report).toContain("Blast radius: 2/50 models (4.0%)")
  })
})

describe("findDownstream with versioned models", () => {
  test("a versioned parent is matched by unique_id, whose last segment is the version", () => {
    const models = [
      { name: "orders", unique_id: "model.p.orders.v2", depends_on: [] },
      { name: "rpt", unique_id: "model.p.rpt", depends_on: ["model.p.orders.v2"] },
    ]
    expect(findDownstream("orders", models, "model.p.orders.v2").map((d) => [d.name, d.unique_id])).toEqual([["rpt", "model.p.rpt"]])
    expect(findDownstream("orders", models)).toEqual([])
  })

  test("with an exact id, another package's model of the same name is not matched", () => {
    const models = [
      { name: "orders", unique_id: "model.a.orders", depends_on: [] },
      { name: "orders", unique_id: "model.b.orders", depends_on: [] },
      { name: "b_only", unique_id: "model.b.b_only", depends_on: ["model.b.orders"] },
    ]
    expect(findDownstream("orders", models, "model.a.orders")).toEqual([])
    expect(findDownstream("orders", models, "model.b.orders").map((d) => d.name)).toEqual(["b_only"])
  })
})
