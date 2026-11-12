import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ENGINE, MAX_ANSWER_COLUMNS, columnAnswer, type ColumnAnswer } from "../../src/altimate/native/dbt/column-answer"
import { columnReach } from "../../src/altimate/native/dbt/column-reach"
import { clearLineageCaches, hasNestedWith, howOf, quotingIsClear, relationUse, shapeFlags, stripAggFilter, stripSql } from "../../src/altimate/native/dbt/project-lineage"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  clearLineageCaches()
})

const model = (
  name: string,
  deps: string[],
  sql: string,
  columns: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  resource_type: "model",
  unique_id: `model.shop.${name}`,
  name,
  alias: name,
  database: "shop",
  schema: "main",
  original_file_path: `models/marts/${name}.sql`,
  depends_on: { nodes: deps.map((d) => (d.includes(".") ? d : `model.shop.${d}`)) },
  config: { materialized: "table" },
  compiled_code: sql,
  columns: Object.fromEntries(columns.map((c) => [c, { name: c, data_type: "double" }])),
  ...extra,
})

const source = (name: string, columns: string[]) => ({
  resource_type: "source",
  unique_id: `source.shop.raw.${name}`,
  name,
  identifier: name,
  database: "shop",
  schema: "raw",
  columns: Object.fromEntries(columns.map((c) => [c, { name: c }])),
})

const T = (name: string) => `shop.main.${name}`

// fct_orders.revenue (renamed from stg_orders.amount) is:
// - summed under a FILTER into fct_daily.paid_revenue,
// - renamed and calculated by mart_ltv (an enforced contract), then passed through a CTE by rpt_ltv,
// - only filtered on by rpt_big_orders (whose child may carry it),
// - read by rpt_nested through a WITH inside a CTE (unresolved; its child may carry it),
// - never read by rpt_counts (cleared).
function shop() {
  const nodes: Record<string, any> = {
    "model.shop.stg_orders": model(
      "stg_orders",
      ["source.shop.raw.orders"],
      "select order_id, customer_id, amount, status from shop.raw.orders",
    ),
    "model.shop.fct_orders": model(
      "fct_orders",
      ["stg_orders"],
      `select order_id, customer_id, amount as revenue, status from ${T("stg_orders")}`,
      ["order_id", "revenue"],
    ),
    "model.shop.fct_daily": model(
      "fct_daily",
      ["fct_orders"],
      `select customer_id, sum(revenue) filter (where status = 'paid') as paid_revenue, count(*) as orders from ${T("fct_orders")} group by customer_id`,
    ),
    "model.shop.mart_ltv": model(
      "mart_ltv",
      ["fct_orders"],
      `select order_id, revenue as ltv, revenue * 2 as double_rev from ${T("fct_orders")}`,
      [],
      { config: { materialized: "table", contract: { enforced: true } } },
    ),
    "model.shop.rpt_ltv": model(
      "rpt_ltv",
      ["mart_ltv"],
      `with x as (select order_id, ltv from ${T("mart_ltv")}) select order_id, ltv from x`,
    ),
    "model.shop.rpt_big_orders": model(
      "rpt_big_orders",
      ["fct_orders"],
      `select order_id from ${T("fct_orders")} where revenue > 100`,
    ),
    "model.shop.rpt_big_child": model(
      "rpt_big_child",
      ["rpt_big_orders"],
      `select order_id from ${T("rpt_big_orders")}`,
    ),
    "model.shop.rpt_counts": model(
      "rpt_counts",
      ["fct_orders"],
      `select count(order_id) as orders from ${T("fct_orders")}`,
    ),
    "model.shop.rpt_nested": model(
      "rpt_nested",
      ["fct_orders"],
      `with a as (with b as (select order_id, revenue from ${T("fct_orders")}) select order_id, revenue from b) select order_id, revenue from a`,
    ),
    "model.shop.rpt_nested_child": model(
      "rpt_nested_child",
      ["rpt_nested"],
      `select order_id, revenue from ${T("rpt_nested")}`,
    ),
    "test.shop.not_null_fct_orders_revenue": {
      resource_type: "test",
      depends_on: { nodes: ["model.shop.fct_orders"] },
    },
  }
  return {
    metadata: { adapter_type: "duckdb", generated_at: "2026-01-01T00:00:00Z" },
    nodes,
    sources: { "source.shop.raw.orders": source("orders", ["order_id", "customer_id", "amount", "status"]) },
    exposures: {
      "exposure.shop.ltv_board": {
        name: "ltv_board",
        label: "LTV board",
        depends_on: { nodes: ["model.shop.rpt_ltv"] },
      },
    },
  }
}

function write(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "column-answer-"))
  dirs.push(dir)
  mkdirSync(join(dir, "target"))
  const file = join(dir, "target", "manifest.json")
  writeFileSync(file, JSON.stringify(manifest))
  return file
}

const at = (a: ColumnAnswer, model: string, column: string) =>
  a.columns.findIndex((c) => a.nodes[c.model]!.name === model && c.column === column)
const col = (a: ColumnAnswer, model: string, column: string) => a.columns[at(a, model, column)]
const named = (a: ColumnAnswer, idx: number) => a.nodes[idx]!.name

describe("column answer: downstream", () => {
  test("follows the value through a rename, a calculation, an aggregate FILTER and a CTE", () => {
    const a = columnAnswer(write(shop()), "fct_orders", "revenue")
    const reached = a.columns
      .slice(1)
      .map((c) => `${a.nodes[c.model]!.name}.${c.column}`)
      .sort()
    expect(reached).toEqual(["fct_daily.paid_revenue", "mart_ltv.double_rev", "mart_ltv.ltv", "rpt_ltv.ltv"])
    expect(a.counts).toMatchObject({ columns: 4, models: 3, hops: 2, contracts: 1, ends: 3 })
  })

  test("an aggregate FILTER clause no longer hides the aggregate, and is flagged", () => {
    const a = columnAnswer(write(shop()), "fct_orders", "revenue")
    expect(at(a, "fct_daily", "paid_revenue")).toBeGreaterThan(0)
    expect(a.flags).toContainEqual({
      model: a.nodes.findIndex((n) => n.name === "fct_daily"),
      flag: "filter_rewritten",
    })
  })

  test("tiers: also reads, unresolved and what sits past them may carry it; the rest is cleared", () => {
    const a = columnAnswer(write(shop()), "fct_orders", "revenue")
    expect(
      a.also_reads.map((r) => ({ name: named(a, r.model), columns: r.columns, downstream: r.downstream })),
    ).toEqual([{ name: "rpt_big_orders", columns: ["revenue"], downstream: 1 }])
    expect(a.unresolved.map((u) => [named(a, u.model), u.downstream])).toEqual([["rpt_nested", 1]])
    // value 3 + may carry 4 (rpt_big_orders, rpt_big_child, rpt_nested, rpt_nested_child) + cleared 1 (rpt_counts)
    expect(a.counts).toMatchObject({ may_carry_models: 4, cleared_models: 1, model_level: 8 })
    expect(a.cleared).toEqual([{ id: "model.shop.rpt_counts", name: "rpt_counts" }])
    expect(a.nodes.map((n) => n.name)).not.toContain("rpt_counts")
  })

  test("a WITH nested inside a CTE is unresolved with the reason, never cleared, and flagged", () => {
    const a = columnAnswer(write(shop()), "fct_orders", "revenue")
    const nested = a.unresolved.find((u) => named(a, u.model) === "rpt_nested")!
    expect(nested.reason).toContain("WITH nested inside a CTE")
    expect(a.flags).toContainEqual({ model: nested.model, flag: "nested_with" })
    expect(at(a, "rpt_nested", "revenue")).toBe(-1)
  })

  test("a union all of select * over columns the engine can't see is unresolved, not cleared", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: { "source.shop.raw.a": source("a", []), "source.shop.raw.b": source("b", []) },
      nodes: {
        "model.shop.m_a": model("m_a", ["source.shop.raw.a"], "select * from shop.raw.a"),
        "model.shop.m_b": model("m_b", ["source.shop.raw.b"], "select * from shop.raw.b"),
        "model.shop.m_union": model(
          "m_union",
          ["m_a", "m_b"],
          `select * from ${T("m_a")} union all select * from ${T("m_b")}`,
        ),
      },
    }
    const a = columnAnswer(write(m), "m_a", "id")
    expect(a.unresolved.map((u) => named(a, u.model))).toEqual(["m_union"])
    expect(a.unresolved[0]!.reason).toContain("traced no column")
    expect(a.counts).toMatchObject({ columns: 0, may_carry_models: 1, cleared_models: 0, model_level: 1 })
  })

  test("an ephemeral focus's readers may carry it, never cleared: their SQL names its parents' columns", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "model.shop.base": model("base", [], "select 1 as id, 2 as amount", ["id", "amount"]),
        "model.shop.eph": model("eph", ["base"], `select * from ${T("base")}`, ["id", "amount"], { config: { materialized: "ephemeral" } }),
        "model.shop.r_star": model("r_star", ["eph"], `with __dbt__cte__eph as (select * from ${T("base")}) select * from __dbt__cte__eph`),
      },
    }
    const a = columnAnswer(write(m), "eph", "amount")
    expect(a.cleared.map((one) => one.name)).toEqual([])
    expect(a.may_carry.map((m) => [m.name, m.reason])).toEqual([["r_star", "ephemeral"]])
  })

  test("a reader the engine reads only in part, or whose columns it can't list, is unresolved, never cleared", () => {
    // Snowflake path access the engine parses only in part (`::variant:`), in a filter and in an output.
    const m = {
      metadata: { adapter_type: "snowflake" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as a, 2 as b", ["a", "b"]),
        "model.shop.r_filter": model("r_filter", ["f"], `select a from ${T("f")} where b::variant:ok::boolean`),
        "model.shop.r_value": model("r_value", ["f"], `select a, b::variant:path::string as c from ${T("f")}`),
        "model.shop.after_filter": model("after_filter", ["r_filter"], `select a from ${T("r_filter")}`),
      },
    }
    const a = columnAnswer(write(m), "f", "b")
    expect(a.cleared.map((one) => one.name)).toEqual([])
    expect(a.unresolved.map((u) => named(a, u.model)).sort()).toEqual(["r_filter", "r_value"])
    expect(a.unresolved.every((u) => u.reason.length > 0)).toBe(true)
    // What the engine did trace still stands.
    expect(a.columns.map((c) => `${named(a, c.model)}.${c.column}`)).toContain("r_value.c")
    expect(a.counts.may_carry_models).toBeGreaterThanOrEqual(2)
  })

  test("a reader through an ephemeral model is reached", () => {
    const m = shop()
    m.nodes["model.shop.eph"] = model("eph", ["fct_orders"], `select order_id, revenue from ${T("fct_orders")}`, [], {
      config: { materialized: "ephemeral" },
    })
    m.nodes["model.shop.rpt_eph"] = model(
      "rpt_eph",
      ["eph"],
      `with __dbt__cte__eph as (select order_id, revenue from ${T("fct_orders")}) select revenue as eph_revenue from __dbt__cte__eph`,
    )
    const a = columnAnswer(write(m), "fct_orders", "revenue")
    expect(at(a, "rpt_eph", "eph_revenue")).toBeGreaterThan(0)
  })

  test("stops at the column limit, says so, and leaves what it never traced as may carry it, never cleared", () => {
    // One wide model fills the answer; a reader after it, and that reader's child, are never traced.
    const wide = Array.from({ length: MAX_ANSWER_COLUMNS + 5 }, (_, i) => `revenue as c${i}`).join(", ")
    const m = shop()
    m.nodes["model.shop.rpt_wide"] = model("rpt_wide", ["fct_orders"], `select ${wide} from ${T("fct_orders")}`)
    m.nodes["model.shop.rpt_late"] = model("rpt_late", ["fct_orders"], `select order_id, revenue from ${T("fct_orders")}`)
    m.nodes["model.shop.rpt_late_child"] = model("rpt_late_child", ["rpt_late"], "")
    const a = columnAnswer(write(m), "fct_orders", "revenue")
    expect(a.columns).toHaveLength(MAX_ANSWER_COLUMNS)
    expect(a.truncated).toBe(true)
    const cleared = a.cleared.map((c) => c.name)
    expect(cleared).not.toContain("rpt_late")
    expect(cleared).not.toContain("rpt_late_child")
    expect(a.counts.may_carry_models).toBeGreaterThanOrEqual(4)
  })
})

describe("column answer: upstream", () => {
  test("traces a column back to the source through a CTE, a rename and a staging model", () => {
    const a = columnAnswer(write(shop()), "rpt_ltv", "ltv", "upstream")
    expect(a.direction).toBe("upstream")
    const reached = a.columns.slice(1).map((c) => [`${a.nodes[c.model]!.name}.${c.column}`, c.hop])
    expect(reached).toEqual([
      ["mart_ltv.ltv", 1],
      ["fct_orders.revenue", 2],
      ["stg_orders.amount", 3],
      ["orders.amount", 4],
    ])
    expect(a.counts).toMatchObject({ columns: 4, models: 4, hops: 4, ends: 1 })
    expect(col(a, "orders", "amount")!.end).toBe(true)
    // Edges point from the source column to the column it feeds.
    expect(a.edges).toContainEqual([at(a, "fct_orders", "revenue"), at(a, "mart_ltv", "ltv"), "~"])
  })

  test("an unresolved model on the way is reported, and what's above it may carry", () => {
    const a = columnAnswer(write(shop()), "rpt_nested_child", "revenue", "upstream")
    // rpt_nested's SELECT list names revenue, so it is reached; its own SQL is unresolved.
    expect(a.columns.slice(1).map((c) => `${named(a, c.model)}.${c.column}`)).toEqual(["rpt_nested.revenue"])
    expect(
      a.unresolved.map((u) => [named(a, u.model), u.reason.includes("nested inside a CTE"), u.downstream]),
    ).toEqual([["rpt_nested", true, 3]])
    // Everything above it may carry the value: fct_orders, stg_orders and the source.
    expect(a.counts).toMatchObject({ may_carry_models: 3, cleared_models: 0, model_level: 4 })
  })

  test("ancestors in none of the tiers are listed as cleared, by name, outside nodes", () => {
    const m: any = shop()
    m.sources["source.shop.raw.customers"] = source("customers", ["customer_id", "name"])
    m.nodes["model.shop.stg_customers"] = model(
      "stg_customers",
      ["source.shop.raw.customers"],
      "select customer_id, name from shop.raw.customers",
    )
    m.nodes["model.shop.fct_mix"] = model(
      "fct_mix",
      ["fct_orders", "stg_customers"],
      `select o.revenue from ${T("fct_orders")} o join ${T("stg_customers")} c on o.customer_id = c.customer_id`,
    )
    const a = columnAnswer(write(m), "fct_mix", "revenue", "upstream")
    expect(a.cleared).toEqual([
      { id: "source.shop.raw.customers", name: "customers" },
      { id: "model.shop.stg_customers", name: "stg_customers" },
    ])
    expect(a.counts).toMatchObject({ models: 3, cleared_models: 2, model_level: 5 })
    expect(a.nodes.map((n) => n.name)).not.toContain("stg_customers")
  })
})

describe("column answer: how", () => {
  test("uses the engine's label, and marks a name match as inferred", () => {
    const a = columnAnswer(write(shop()), "fct_orders", "revenue")
    const edge = (m: string, c: string) => a.edges.find((e) => e[1] === at(a, m, c))
    expect(edge("mart_ltv", "ltv")).toEqual([0, at(a, "mart_ltv", "ltv"), "~"])
    expect(edge("mart_ltv", "double_rev")![2]).toBe("ƒ")
    // Through a CTE the engine gives no label: "=" by matching names, never as certain.
    expect(edge("rpt_ltv", "ltv")).toEqual([at(a, "mart_ltv", "ltv"), at(a, "rpt_ltv", "ltv"), "=", "name"])
    expect(col(a, "rpt_ltv", "ltv")).toMatchObject({ how: "=", how_from: "name" })
    expect(col(a, "mart_ltv", "ltv")).toMatchObject({ how: "~", how_from: "engine" })
    expect(a.columns[0]).toMatchObject({ how: null, how_from: null, hop: 0, end: false })
  })

  test("maps each lens to a glyph", () => {
    expect(howOf("Original", [], "a", "a")).toEqual({ how: "=", howFrom: "engine" })
    expect(howOf("Alias", [], "a", "b")).toEqual({ how: "~", howFrom: "engine" })
    expect(howOf("Transformation", [{ expression: "a * 2 AS b" }], "a", "b")).toEqual({ how: "ƒ", howFrom: "engine" })
    expect(howOf("Transformation", [{ expression: "SUM(a) AS b" }], "a", "b")).toEqual({ how: "Σ", howFrom: "engine" })
    expect(howOf("Not sure", [], "a", "a")).toEqual({ how: "=", howFrom: "name" })
    expect(howOf("Not sure", [], "a", "b")).toEqual({ how: "?", howFrom: null })
  })
})

describe("column answer: SQL rewrites and shapes", () => {
  test("drops aggregate FILTER clauses, parentheses and quotes included", () => {
    expect(stripAggFilter("select sum(x) filter (where (a) = ')') as s, count(*) FILTER(WHERE b) n from t")).toBe(
      "select sum(x) as s, count(*) n from t",
    )
    expect(stripAggFilter("select x from t where y in (select 1)")).toBe("select x from t where y in (select 1)")
  })

  test("finds a WITH nested inside a CTE, not one in a comment", () => {
    expect(hasNestedWith("with a as (with b as (select 1) select * from b) select * from a")).toBe(true)
    expect(hasNestedWith("with a as (select 1), b as (select 2) select * from a, b")).toBe(false)
    expect(hasNestedWith("with a as (select 1 -- (with b as (\n) select * from a")).toBe(false)
  })

  test("flags unnest, pivot and except", () => {
    expect(shapeFlags("select v from t cross join unnest(t.arr) as u(v)")).toEqual(["unnest"])
    expect(shapeFlags("select * from t pivot (sum(x) for k in ('a'))")).toEqual(["pivot"])
    expect(shapeFlags("select a from t except select a from u")).toEqual(["except"])
    expect(shapeFlags("select 'unnest(' as s -- pivot")).toEqual([])
  })
})

describe("column answer: consumers", () => {
  const exposure = (name: string, deps: string[], extra: Record<string, unknown> = {}) => ({
    name,
    type: "dashboard",
    depends_on: { nodes: deps },
    ...extra,
  })
  const withExposures = (exposures: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
    ...shop(),
    exposures,
    ...more,
  })

  test("each exposure lands in the tier of the models it reads, the closest tier first", () => {
    const a = columnAnswer(
      write(
        withExposures({
          "exposure.shop.z_cleared": exposure("z_cleared", ["model.shop.rpt_counts"]),
          "exposure.shop.m_maybe": exposure("m_maybe", ["model.shop.rpt_big_child"], { type: "notebook" }),
          "exposure.shop.c_carries": exposure("c_carries", ["model.shop.rpt_ltv", "model.shop.rpt_counts"], {
            label: "Carries board",
            url: "https://bi.example.com/1",
            owner: { name: "Data team", email: "data@example.com" },
          }),
          "exposure.shop.a_focus": exposure("a_focus", ["model.shop.fct_orders"]),
          "exposure.shop.upstream_only": exposure("upstream_only", ["model.shop.stg_orders"]),
        }),
      ),
      "fct_orders",
      "revenue",
    )
    expect(a.consumers.declared).toBe(5)
    expect(a.consumers.exposures.map((c) => [c.label, c.tier, c.via])).toEqual([
      ["Carries board", "carries", ["rpt_ltv"]],
      ["a_focus", "carries", ["fct_orders"]],
      ["m_maybe", "may_carry", ["rpt_big_child"]],
      ["z_cleared", "cleared", ["rpt_counts"]],
    ])
    expect(a.consumers.exposures[0]).toMatchObject({ type: "dashboard", url: "https://bi.example.com/1", owner: "Data team" })
    expect(JSON.stringify(a.consumers)).not.toContain("data@example.com")
  })

  test("an exposure that reads a metric reaches the model behind it", () => {
    const a = columnAnswer(
      write(
        withExposures(
          { "exposure.shop.via_metric": exposure("via_metric", ["metric.shop.ltv"]) },
          {
            metrics: { "metric.shop.ltv": { depends_on: { nodes: ["semantic_model.shop.ltv"] } } },
            semantic_models: { "semantic_model.shop.ltv": { depends_on: { nodes: ["model.shop.mart_ltv"] } } },
          },
        ),
      ),
      "fct_orders",
      "revenue",
    )
    expect(a.consumers.exposures.map((c) => [c.name, c.tier, c.via])).toEqual([["via_metric", "carries", ["mart_ltv"]]])
  })

  test("declared tells a project with no exposures from one with none downstream", () => {
    const none = columnAnswer(write(withExposures({})), "fct_orders", "revenue")
    expect(none.consumers).toEqual({ declared: 0, exposures: [] })
    const elsewhere = columnAnswer(
      write(withExposures({ "exposure.shop.up": exposure("up", ["model.shop.stg_orders"]) })),
      "fct_orders",
      "revenue",
    )
    expect(elsewhere.consumers).toEqual({ declared: 1, exposures: [] })
  })

  test("upstream lists none", () => {
    const a = columnAnswer(write(shop()), "fct_orders", "revenue", "upstream")
    expect(a.consumers).toEqual({ declared: 1, exposures: [] })
  })
})

describe("column answer: a column the model doesn't have", () => {
  test("is an error when the model's columns are settled, naming them", () => {
    expect(() => columnAnswer(write(shop()), "fct_orders", "not_a_column")).toThrow(
      "fct_orders has no column not_a_column; its columns are customer_id, order_id, revenue, status",
    )
    expect(() => columnAnswer(write(shop()), "fct_orders", "not_a_column", "upstream")).toThrow("has no column")
  })

  test("matches the column in any case", () => {
    expect(columnAnswer(write(shop()), "fct_orders", "Revenue").counts.models).toBe(3)
  })

  test("answers when a select * leaves the model's columns open", () => {
    const value: any = shop()
    value.sources["source.shop.raw.events"] = source("events", [])
    value.nodes["model.shop.stg_events"] = model("stg_events", ["source.shop.raw.events"], "select * from shop.raw.events")
    const a = columnAnswer(write(value), "stg_events", "kind")
    expect(a.focus).toEqual({ model: "model.shop.stg_events", column: "kind" })
  })
})

describe("column answer: contract", () => {
  test("has the fixed shape", () => {
    const a = columnAnswer(write(shop()), "fct_orders", "revenue")
    expect(Object.keys(a)).toEqual([
      "version",
      "focus",
      "direction",
      "inputs",
      "counts",
      "nodes",
      "columns",
      "edges",
      "also_reads",
      "unresolved",
      "may_carry",
      "flags",
      "cleared",
      "consumers",
      "truncated",
      "next",
    ])
    expect(a.version).toBe(1)
    expect(a.focus).toEqual({ model: "model.shop.fct_orders", column: "revenue" })
    expect(a.direction).toBe("downstream")
    expect(a.inputs).toMatchObject({
      manifest: { generated_at: "2026-01-01T00:00:00Z", older_than_sql: false },
      sql: "compiled_code",
      catalog: null,
      engine: ENGINE,
    })
    expect(a.inputs.workarounds).toContain("aggregate FILTER clause dropped before analysis")
    expect(Object.keys(a.counts).sort()).toEqual(
      ["cleared_models", "columns", "contracts", "ends", "hops", "may_carry_models", "model_level", "models"].sort(),
    )
    expect(a.nodes[0]).toEqual({
      id: "model.shop.fct_orders",
      name: "fct_orders",
      folder: "marts",
      materialized: "table",
      contract: false,
      tests: 1,
      exposures: [],
    })
    expect(a.nodes.find((n) => n.name === "mart_ltv")!.contract).toBe(true)
    expect(a.nodes.find((n) => n.name === "rpt_ltv")!.exposures).toEqual(["LTV board"])
    expect(a.columns[0]).toMatchObject({ model: 0, column: "revenue", hop: 0, type: "double" })
    for (const e of a.edges) {
      expect(typeof e[0]).toBe("number")
      expect(typeof e[1]).toBe("number")
      expect(["=", "~", "ƒ", "Σ", "?"]).toContain(e[2])
    }
    expect(a.truncated).toBe(false)
    expect(a.next).toBeNull()
  })

  test("the engine label matches the pinned altimate-core", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8"))
    expect(ENGINE).toBe(`altimate-core ${pkg.dependencies["@altimateai/altimate-core"]}`)
  })

  test("says when a model file changed after the manifest was written", () => {
    const file = write(shop())
    const dir = join(file, "..", "..")
    mkdirSync(join(dir, "models", "marts"), { recursive: true })
    const later = new Date(Date.now() + 60_000)
    writeFileSync(join(dir, "models", "marts", "mart_ltv.sql"), "select 1")
    require("node:fs").utimesSync(join(dir, "models", "marts", "mart_ltv.sql"), later, later)
    expect(columnAnswer(file, "fct_orders", "revenue").inputs.manifest.older_than_sql).toBe(true)
  })

  test("an unknown model throws", () => {
    expect(() => columnAnswer(write(shop()), "nope", "x")).toThrow("not found")
  })
})

// Each case below is a shape where the answer once cleared a model that can carry the column.
describe("column answer: never cleared while it may carry the column", () => {
  const names = (a: ColumnAnswer) => ({
    cleared: a.cleared.map((one) => one.name),
    unresolved: a.unresolved.map((u) => named(a, u.model)),
    also: a.also_reads.map((x) => named(a, x.model)),
    mayCarry: Object.fromEntries(a.may_carry.map((m) => [m.name, m.reason])),
  })

  test("a star reader over a parent with no known columns, beside another parent's edge, may carry it", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: { "source.shop.raw.u": source("u", []) },
      nodes: {
        "model.shop.f": model("f", ["source.shop.raw.u"], "select * from shop.raw.u"),
        "model.shop.g": model("g", [], "select 1 as x", ["x"]),
        "model.shop.r": model("r", ["f", "g"], `select f.*, g.x from ${T("f")} f cross join ${T("g")} g`),
      },
    }
    const a = names(columnAnswer(write(m), "f", "val"))
    expect(a.cleared).not.toContain("r")
    expect(a.mayCarry.r).toBe("star")
  })

  test("a star reader over a parent whose known columns lack the column may carry it, both ways", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: { "source.shop.raw.orders": source("orders", []) },
      nodes: {
        "model.shop.stg": model("stg", ["source.shop.raw.orders"], "select * from shop.raw.orders", ["order_id"]),
        "model.shop.rpt": model("rpt", ["stg"], `select * from ${T("stg")}`),
      },
      exposures: { "exposure.shop.dash": { name: "dash", label: "Dash", depends_on: { nodes: ["model.shop.rpt"] } } },
    }
    const path = write(m)
    const down = columnAnswer(path, "stg", "amount")
    expect(names(down).cleared).toEqual([])
    expect(names(down).mayCarry.rpt).toBe("star")
    expect(down.consumers.exposures.map((one) => [one.name, one.tier])).toEqual([["dash", "may_carry"]])
    const up = columnAnswer(path, "rpt", "amount", "upstream")
    expect(names(up).cleared).toEqual([])
  })

  test("a qualified star inside a function may carry it even when every column is declared", () => {
    const m = {
      metadata: { adapter_type: "snowflake" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as id, 2 as val", ["id", "val"]),
        "model.shop.r": model("r", ["f"], `select hash(f.*) as h, id from ${T("f")} f`),
      },
    }
    const a = names(columnAnswer(write(m), "f", "val"))
    expect(a.cleared).toEqual([])
    expect(a.mayCarry.r).toBe("star")
  })

  test("what reads a value model may carry it: the value model may filter, join or group on the column", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as id, 2 as val", ["id", "val"]),
        "model.shop.r": model("r", ["f"], `select val as v, id from ${T("f")} where val > 1`),
        "model.shop.child": model("child", ["r"], `select id from ${T("r")}`),
      },
    }
    const a = names(columnAnswer(write(m), "f", "val"))
    expect(a.mayCarry.child).toBe("reads_value_model")
    expect(a.cleared).toEqual([])
  })

  test("a NATURAL JOIN reader and an IDENTIFIER() reader may carry it", () => {
    const natural = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as id, 2 as val", ["id", "val"]),
        "model.shop.g": model("g", [], "select 1 as id, 2 as val", ["id", "val"]),
        "model.shop.r": model("r", ["f", "g"], `select g.id from ${T("f")} natural join ${T("g")}`),
      },
    }
    expect(names(columnAnswer(write(natural), "f", "val")).mayCarry.r).toBe("natural_join")
    const identifier = {
      metadata: { adapter_type: "snowflake" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as id, 2 as val", ["id", "val"]),
        "model.shop.r": model("r", ["f"], `select id, identifier('val') as x from ${T("f")}`),
      },
    }
    const b = names(columnAnswer(write(identifier), "f", "val"))
    expect(b.mayCarry.r).toBe("dynamic_name")
    expect(b.cleared).toEqual([])
  })

  test("upstream, an ephemeral model the value passes through is not cleared", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "model.shop.base": model("base", [], "select 1 as id, 2 as amount", ["id", "amount"]),
        "model.shop.eph": model("eph", ["base"], `select id, amount * 2 as doubled from ${T("base")}`, ["id", "doubled"], {
          config: { materialized: "ephemeral" },
        }),
        "model.shop.r": model(
          "r",
          ["eph"],
          `with __dbt__cte__eph as (select id, amount * 2 as doubled from ${T("base")}) select doubled as total from __dbt__cte__eph`,
          ["total"],
        ),
      },
    }
    const a = columnAnswer(write(m), "r", "total", "upstream")
    expect(a.columns.map((c) => `${named(a, c.model)}.${c.column}`)).toContain("base.amount")
    expect(names(a).cleared).not.toContain("eph")
  })

  test("upstream, an ephemeral model that starts the value as a constant is not cleared", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "model.shop.e": model("e", [], "select 2 as val", ["val"], { config: { materialized: "ephemeral" } }),
        "model.shop.r": model("r", ["e"], "with __dbt__cte__e as (select 2 as val) select val from __dbt__cte__e", ["val"]),
      },
    }
    expect(names(columnAnswer(write(m), "r", "val", "upstream")).cleared).toEqual([])
  })

  test("a filter on the name of an output the column feeds counts as reading it", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as id, 2 as val", ["id", "val"]),
        "model.shop.r": model("r", ["f"], `with x as (select val as v, id from ${T("f")}) select v, id from x where v > 1`),
        "model.shop.child": model("child", ["r"], `select id from ${T("r")}`),
      },
    }
    const a = names(columnAnswer(write(m), "f", "val"))
    expect(a.mayCarry.child).toBe("reads_value_model")
    expect(a.cleared).toEqual([])
  })

  test("IDENTIFIER() naming a longer column doesn't make a reader of a shorter one unresolved", () => {
    const m = {
      metadata: { adapter_type: "snowflake" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as id, 2 as order_id", ["id", "order_id"]),
        "model.shop.r": model("r", ["f"], `select id, identifier('order_id') as x from ${T("f")}`),
      },
    }
    expect(names(columnAnswer(write(m), "f", "id")).unresolved).toEqual([])
  })

  test("a quoted relation (BigQuery backticks) still ties a qualified star to its parent", () => {
    const m = {
      metadata: { adapter_type: "bigquery" },
      sources: { "source.shop.raw.orders": source("orders", []) },
      nodes: {
        "model.shop.stg": model("stg", ["source.shop.raw.orders"], "select * from `shop`.`raw`.`orders`", ["order_id"]),
        "model.shop.rpt": model("rpt", ["stg"], "select o.* from `shop`.`main`.`stg` o"),
      },
    }
    const a = names(columnAnswer(write(m), "stg", "amount"))
    expect(a.mayCarry.rpt).toBe("star")
    expect(a.cleared).toEqual([])
  })

  test("upstream, IDENTIFIER() naming a parent's column leaves the output unresolved", () => {
    const m = {
      metadata: { adapter_type: "snowflake" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as id, 2 as val", ["id", "val"]),
        "model.shop.r": model("r", ["f"], `select id, identifier('val') as x from ${T("f")}`, ["id", "x"]),
      },
    }
    expect(names(columnAnswer(write(m), "r", "x", "upstream")).cleared).toEqual([])
  })

  test("a filter on the column after a subquery in the same WHERE still counts as reading it", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as id, 2 as val", ["id", "val"]),
        "model.shop.g": model("g", [], "select 1 as k", ["k"]),
        "model.shop.r": model("r", ["f", "g"], `select f.val as v, f.id from ${T("f")} f where exists (select 1 from ${T("g")}) and f.val > 0`),
        "model.shop.child": model("child", ["r"], `select id from ${T("r")}`),
      },
    }
    const a = names(columnAnswer(write(m), "f", "val"))
    expect(a.mayCarry.child).toBe("reads_value_model")
    expect(a.cleared).not.toContain("child")
  })

  test("a seed whose header can't be read isn't settled by its docs", () => {
    const seed = {
      resource_type: "seed",
      unique_id: "seed.shop.s",
      name: "s",
      alias: "s",
      database: "shop",
      schema: "main",
      original_file_path: "seeds/missing.csv",
      config: { materialized: "seed" },
      columns: { id: { name: "id" } },
    }
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "seed.shop.s": seed,
        "model.shop.stg": model("stg", ["seed.shop.s"], `select * from ${T("s")}`),
        "model.shop.rpt": model("rpt", ["stg"], `select id, amount from ${T("stg")}`),
      },
    }
    const path = write(m)
    expect(() => columnAnswer(path, "stg", "amount")).not.toThrow()
    expect(columnReach(path, "stg", "amount").models.map((one) => one.name)).toEqual(["rpt"])
  })

  test("a filter on a quoted name with a space or a dot still counts as reading it", () => {
    const m = {
      metadata: { adapter_type: "snowflake" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], 'select 1 as id, 2 as "net.amount"', ["id", "net.amount"]),
        "model.shop.r": model("r", ["f"], `select "net.amount" as v, id from ${T("f")} where "net.amount" > 0`),
        "model.shop.child": model("child", ["r"], `select id from ${T("r")}`),
      },
    }
    const a = names(columnAnswer(write(m), "f", "net.amount"))
    expect(a.cleared).not.toContain("child")
    const spaced = {
      metadata: { adapter_type: "snowflake" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], 'select 1 as id, 2 as "order id"', ["id", "order id"]),
        "model.shop.r": model("r", ["f"], `select "order id" as v, id from ${T("f")} where "order id" > 0`),
        "model.shop.child": model("child", ["r"], `select id from ${T("r")}`),
      },
    }
    expect(names(columnAnswer(write(spaced), "f", "order id")).cleared).not.toContain("child")
  })

  test("a seed with an empty first line isn't settled by its docs", () => {
    const dir = mkdtempSync(join(tmpdir(), "column-answer-"))
    dirs.push(dir)
    mkdirSync(join(dir, "target"))
    mkdirSync(join(dir, "seeds"))
    writeFileSync(join(dir, "seeds", "s.csv"), "\n1,2\n")
    writeFileSync(join(dir, "dbt_project.yml"), "name: shop\n")
    const seed = {
      resource_type: "seed",
      unique_id: "seed.shop.s",
      name: "s",
      alias: "s",
      database: "shop",
      schema: "main",
      original_file_path: "seeds/s.csv",
      config: { materialized: "seed" },
      columns: { id: { name: "id" } },
    }
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "seed.shop.s": seed,
        "model.shop.stg": model("stg", ["seed.shop.s"], `select * from ${T("s")}`),
        "model.shop.rpt": model("rpt", ["stg"], `select id, amount from ${T("stg")}`),
      },
    }
    const file = join(dir, "target", "manifest.json")
    writeFileSync(file, JSON.stringify(m))
    expect(() => columnAnswer(file, "stg", "amount")).not.toThrow()
  })

  test("a star over a source documented only in part leaves its other columns real, in both tools", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: { "source.shop.raw.orders": source("orders", ["order_id"]) },
      nodes: {
        "model.shop.stg": model("stg", ["source.shop.raw.orders"], "select * from shop.raw.orders"),
        "model.shop.rpt": model("rpt", ["stg"], `select order_id, amount from ${T("stg")}`),
      },
    }
    const path = write(m)
    expect(() => columnAnswer(path, "stg", "amount")).not.toThrow()
    expect(columnReach(path, "stg", "amount").models.map((one) => one.name)).toEqual(["rpt"])
  })
})

// "Cleared" only when proven: a reader of the edited model proves it doesn't read the column only when the
// engine read its SQL in full, it has no `*`, NATURAL JOIN, run-time name, whole-row value or ephemeral
// model, and its SQL never names the column. Everything else may carry it, with a reason.
describe("column answer: cleared only when proven", () => {
  const base = (sql: string, dialect = "duckdb") => ({
    metadata: { adapter_type: dialect },
    sources: {},
    nodes: {
      "model.shop.f": model("f", [], "select 1 as id, 2 as val", ["id", "val"]),
      "model.shop.r": model("r", ["f"], sql),
      "model.shop.after": model("after", ["r"], `select 1 as one from ${T("r")}`),
    },
  })
  const reasons = (a: ColumnAnswer) => Object.fromEntries(a.may_carry.map((m) => [m.name, [m.reason, m.via ?? null]]))

  test("a reader that never names the column, read in full, is cleared, and so is what sits past it", () => {
    const a = columnAnswer(write(base(`select id from ${T("f")} where id > 0`)), "f", "val")
    expect(a.cleared.map((one) => one.name)).toEqual(["after", "r"])
    expect(a.may_carry).toEqual([])
  })

  test("a reader that names the column with no traced edge may carry it, and what sits past it is below it", () => {
    const a = columnAnswer(write(base(`select id from ${T("f")} where val > 0`)), "f", "val")
    expect(reasons(a)).toEqual({ r: ["names_column", null], after: ["below", "r"] })
    expect(a.cleared).toEqual([])
  })

  test("a whole row used as a value may carry it", () => {
    for (const sql of [`select to_json(t) as j from ${T("f")} t`, `select t::varchar as j from ${T("f")} t`]) {
      expect(reasons(columnAnswer(write(base(sql)), "f", "val")).r?.[0]).toBe("row_reference")
    }
  })

  test("a column named at run time may carry it: IDENTIFIER (a comment before its parenthesis too), COLUMNS, $n", () => {
    for (const [sql, dialect] of [
      [`select id, identifier /* c */ ('id') as x from ${T("f")}`, "snowflake"],
      [`select id, columns('i.*') from ${T("f")}`, "duckdb"],
      [`select id, $1 as x from ${T("f")}`, "snowflake"],
    ] as const) {
      expect(reasons(columnAnswer(write(base(sql, dialect)), "f", "val")).r?.[0]).toBe("dynamic_name")
    }
  })

  test("what reads a model the value reaches may carry it, naming that model; the reached model itself carries it", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as id, 2 as val", ["id", "val"]),
        "model.shop.v": model("v", ["f"], `select val * 2 as doubled, id from ${T("f")}`),
        "model.shop.ids": model("ids", ["v"], `select id from ${T("v")}`),
      },
    }
    const a = columnAnswer(write(m), "f", "val")
    expect(a.columns.map((c) => `${named(a, c.model)}.${c.column}`)).toContain("v.doubled")
    expect(reasons(a)).toEqual({ ids: ["reads_value_model", "v"] })
    expect(a.counts).toMatchObject({ models: 1, may_carry_models: 1, cleared_models: 0 })
  })

  test("only models the engine couldn't read are unresolved, each with its code", () => {
    const m = base(`select id from ${T("f")} where val::variant:ok::boolean`, "snowflake")
    const a = columnAnswer(write(m), "f", "val")
    expect(a.unresolved.map((u) => [named(a, u.model), u.code])).toEqual([["r", "read_in_part"]])
    expect(reasons(a).r?.[0]).toBe("read_in_part")
    // A `*` is a reason to doubt, not a failure to read: the star reader isn't listed as unresolved.
    const star = columnAnswer(write(base(`select id, hash(*) as h from ${T("f")} where val > 0`)), "f", "val")
    expect(star.unresolved.map((u) => named(star, u.model))).not.toContain("r")
  })

  test("a quoted name holding comment marks is one name, so a filter on it still counts", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], 'select 1 as id, 2 as "a--b", 3 as "c/*d"', ["id", "a--b", "c/*d"]),
        "model.shop.r": model("r", ["f"], `select id from ${T("f")} where "a--b" > 0`),
        "model.shop.s": model("s", ["f"], `select id from ${T("f")} where "c/*d" > 0 and id > 0`),
      },
    }
    const path = write(m)
    expect(columnAnswer(path, "f", "a--b").cleared.map((one) => one.name)).not.toContain("r")
    expect(columnAnswer(path, "f", "c/*d").cleared.map((one) => one.name)).not.toContain("s")
    // The engine can't parse these names today; the text check keeps them whole either way.
    expect(stripSql('select id from f where "a--b" > 0')).toBe('select id from f where "a--b" > 0')
    expect(stripSql("select id from f where `c/*d` > 0 -- note")).toBe("select id from f where `c/*d` > 0  ")
  })

  test("a whole row selected under an alias, or from a table listed after a comma, may carry it", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as id, 2 as val", ["id", "val"]),
        "model.shop.g": model("g", [], "select 1 as k", ["k"]),
        "model.shop.r_as": model("r_as", ["f"], `select t as row_value from ${T("f")} t`),
        "model.shop.r_comma": model("r_comma", ["f", "g"], `select o.k, to_json(f) as j from ${T("g")} o, ${T("f")}`),
      },
    }
    const a = reasons(columnAnswer(write(m), "f", "val"))
    expect(a.r_as?.[0]).toBe("row_reference")
    expect(a.r_comma?.[0]).toBe("row_reference")
  })

  test("quoting the check can't read for certain stops the proof: a bracket name, a backslash, a dollar-quote", () => {
    for (const sql of [
      `select id from ${T("f")} where [c--d] > 0`,
      `select id from ${T("f")} where id <> 'it\\'s'`,
      `select id, $$x$$ as note from ${T("f")}`,
    ]) {
      // The guard itself, then the answer: never cleared, whether the engine or the guard stops it.
      expect(quotingIsClear(sql)).toBe(false)
      const a = columnAnswer(write(base(sql, "duckdb")), "f", "val")
      expect(a.cleared.map((one) => one.name)).not.toContain("r")
    }
    expect(quotingIsClear(`select id from ${T("f")} where note = 'a''b' and "c""d" > 0`)).toBe(true)
    expect(stripSql("select id from f where [c--d] > 0")).toBe("select id from f where [c--d] > 0")
    // A model the engine reads in full but whose quoting the check can't: the guard alone gives the reason.
    const guarded = reasons(columnAnswer(write(base(`select id, $$x$$ as note from ${T("f")}`, "snowflake")), "f", "val"))
    expect(guarded.r?.[0]).toBe("unclear_sql")
  })

  test("a FROM list the check can't classify stops the proof: a table function, TABLESAMPLE, an unquoted dash", () => {
    for (const [sql, dialect] of [
      [`select f.id, x.value from ${T("f")} f, lateral flatten(input => f.id) x`, "snowflake"],
      [`select id from ${T("f")} tablesample (10)`, "duckdb"],
    ] as const) {
      expect(relationUse(sql)).toBe("unclear")
      const a = columnAnswer(write(base(sql, dialect)), "f", "val")
      expect(a.cleared.map((one) => one.name)).not.toContain("r")
    }
    expect(relationUse("select id from my-project.ds.f o")).toBe("unclear")
    // FROM inside extract/trim/substring is syntax, not a table list; inside other functions it stays a table list.
    expect(relationUse("select extract(year from d) as y, d from db.s.f")).toBeNull()
    expect(relationUse("select array(select t from db.s.g t) as a from db.s.f")).toBe("row")
    // A table after a comma that follows a join condition is still in the list, so its whole row counts.
    expect(relationUse("select c, f.id from shop.main.f f join shop.main.g g on f.id = g.k, shop.main.c")).toBe("row")
    expect(relationUse("select c, f.id from shop.main.f f join shop.main.g g using (id), shop.main.c")).toBe("row")
    expect(relationUse("select f.id from shop.main.f f join shop.main.g g on f.id = g.k, shop.main.c c where c.x > 0")).toBeNull()
    expect(relationUse("select id from db.s.f f left join db.s.g g using (id) where f.id > 1")).toBeNull()
  })

  test("the same manifest gives the same may_carry list, in name order", () => {
    const m = {
      metadata: { adapter_type: "duckdb" },
      sources: {},
      nodes: {
        "model.shop.f": model("f", [], "select 1 as id, 2 as val", ["id", "val"]),
        "model.shop.z": model("z", ["f"], `select to_json(t) as j from ${T("f")} t`),
        "model.shop.a": model("a", ["f"], `select id from ${T("f")} where val > 1`),
      },
    }
    const path = write(m)
    const one = JSON.stringify(columnAnswer(path, "f", "val").may_carry)
    clearLineageCaches()
    expect(JSON.stringify(columnAnswer(path, "f", "val").may_carry)).toBe(one)
    expect(JSON.parse(one).map((x: any) => x.name)).toEqual(["a", "z"])
  })
})

