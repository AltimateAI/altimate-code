import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as core from "@altimateai/altimate-core"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { columnReach, exposuresOn, parentsNamed, selectsStar } from "../../src/altimate/native/dbt/column-reach"
import { lineageGraph } from "../../src/altimate/native/dbt/graph"
import { structuredError, structuredResult } from "../../src/altimate/mcp-server/server"
import { dbtLineage } from "../../src/altimate/native/dbt/lineage"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const column = (name: string) => ({ name, data_type: "double" })
const model = (name: string, deps: string[], sql: string, columns: string[], extra: Record<string, unknown> = {}) => ({
  resource_type: "model",
  unique_id: `model.shop.${name}`,
  name,
  alias: name,
  schema: "main",
  database: "shop",
  original_file_path: `models/${name}.sql`,
  depends_on: { nodes: deps },
  compiled_code: sql,
  columns: Object.fromEntries(columns.map((c) => [c, column(c)])),
  ...extra,
})

// fct_orders.revenue is carried by fct_daily, renamed to ltv by mart_ltv (and read through it by
// rpt_ltv), filtered on by rpt_big_orders, and never read by rpt_counts.
function manifest() {
  const nodes: Record<string, any> = {
    "model.shop.fct_orders": model("fct_orders", [], "select order_id, revenue, gross_revenue from raw.orders", ["order_id", "revenue", "gross_revenue"]),
    "model.shop.fct_daily": model("fct_daily", ["model.shop.fct_orders"], "select sum(revenue) as revenue from fct_orders", ["revenue"]),
    "model.shop.mart_ltv": model("mart_ltv", ["model.shop.fct_orders"], "select order_id, revenue as ltv from fct_orders", ["order_id", "ltv"]),
    "model.shop.rpt_ltv": model("rpt_ltv", ["model.shop.mart_ltv"], "select max(ltv) as top_ltv from mart_ltv", ["top_ltv"]),
    "model.shop.rpt_big_orders": model("rpt_big_orders", ["model.shop.fct_orders"], "select order_id from fct_orders where revenue > 100", ["order_id"]),
    "model.shop.rpt_counts": model("rpt_counts", ["model.shop.fct_orders"], "select count(order_id) as orders from fct_orders", ["orders"]),
  }
  return {
    metadata: { adapter_type: "duckdb" },
    nodes,
    sources: {},
    exposures: {
      "exposure.shop.exec_revenue": { name: "exec_revenue", label: "Exec Revenue", type: "dashboard", depends_on: { nodes: ["model.shop.fct_daily"] } },
      "exposure.shop.ops": { name: "ops", type: "application", depends_on: { nodes: ["model.shop.rpt_counts"] } },
    },
  }
}

function manifestFile(value: Record<string, unknown> = manifest()) {
  const dir = mkdtempSync(join(tmpdir(), "column-reach-"))
  dirs.push(dir)
  const file = join(dir, "manifest.json")
  writeFileSync(file, JSON.stringify(value))
  return file
}

describe("columnReach", () => {
  test("follows a column through renames to the models and dashboards that read it", () => {
    const reach = columnReach(manifestFile(), "fct_orders", "REVENUE")
    const byName = Object.fromEntries(reach.models.map((m) => [m.name, m.columns]))
    expect(byName).toEqual({ fct_daily: ["revenue"], mart_ltv: ["ltv"], rpt_ltv: ["top_ltv"] })
    // The engine reports no edge for a filter: the model is a possible reader, not a certain one.
    expect(reach.uncertain).toEqual([
      { name: "rpt_big_orders", unique_id: "model.shop.rpt_big_orders", reason: "names it only outside its select list (WHERE, JOIN, GROUP BY or HAVING)" },
    ])
    expect(reach.untraced).toEqual([])
    expect(reach.exposures).toEqual([{ unique_id: "exposure.shop.exec_revenue", name: "exec_revenue", label: "Exec Revenue", type: "dashboard" }])
    expect(reach.truncated).toBe(false)
  })

  test("an output alias or a comment naming the column is not a read", () => {
    const value = manifest()
    value.nodes["model.shop.rpt_counts"].compiled_code = "select count(order_id) as revenue /* revenue */ from fct_orders -- revenue"
    const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
    expect(reach.uncertain.map((m) => m.name)).toEqual(["rpt_big_orders"])
  })

  test("a downstream model without compiled SQL is reported untraced, and what reads it only may read the column", () => {
    const value = manifest()
    value.nodes["model.shop.mart_ltv"].compiled_code = ""
    const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
    expect(reach.models.map((m) => m.name).sort()).toEqual(["fct_daily"])
    expect(reach.untraced).toEqual([
      { name: "mart_ltv", unique_id: "model.shop.mart_ltv", reason: "No compiled SQL found — run `dbt compile` first" },
    ])
    expect(reach.uncertain.map((m) => [m.name, m.reason])).toContainEqual(["rpt_ltv", "is downstream of a model that could not be traced or reads it ambiguously"])
  })

  test("a model that only filters on the column passes nothing on to its children", () => {
    const value = manifest()
    value.nodes["model.shop.rpt_after_filter"] = model("rpt_after_filter", ["model.shop.rpt_big_orders"], "select count(order_id) as n from rpt_big_orders", ["n"])
    const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
    expect(reach.uncertain.map((m) => m.name)).toEqual(["rpt_big_orders"])
  })

  test("a join key another parent also documents is a possible read, not a dropped one", () => {
    const value = manifest()
    value.nodes["model.shop.dim_orders"] = model("dim_orders", [], "select order_id, revenue from raw.dim", ["order_id", "revenue"])
    value.nodes["model.shop.rpt_joined"] = model(
      "rpt_joined",
      ["model.shop.fct_orders", "model.shop.dim_orders"],
      "select d.order_id from fct_orders f join dim_orders d on f.order_id = d.order_id where f.revenue > 0",
      ["order_id"],
    )
    const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
    expect(reach.uncertain.find((m) => m.name === "rpt_joined")?.reason).toBe(
      "names it outside its select list, or names another parent's column of the same name",
    )
  })

  test("a source and a model with the same table name: a qualified source column is not the model's", () => {
    const value: any = manifest()
    value.sources = {
      "source.shop.raw.fct_orders": { resource_type: "source", name: "fct_orders", identifier: "fct_orders", schema: "raw", database: "shop", columns: { revenue: column("revenue") } },
    }
    value.nodes["model.shop.rpt_src"] = model(
      "rpt_src",
      ["model.shop.fct_orders", "source.shop.raw.fct_orders"],
      "select s.revenue as src_revenue from raw.fct_orders s join main.fct_orders m on s.revenue = m.order_id",
      ["src_revenue"],
    )
    const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
    expect(reach.models.map((m) => m.name)).not.toContain("rpt_src")
  })

  test("a table name two parents share is ambiguous; a schema-qualified one is not", () => {
    const base = manifest()
    const other = model("orders_copy", [], "select order_id, revenue from raw.copy", ["order_id", "revenue"], { alias: "fct_orders", schema: "archive" })
    const sql = (from: string) => `select b.revenue as kept from ${from}`
    const child = (from: string) =>
      model("rpt_join", ["model.shop.fct_orders", "model.shop.orders_copy"], sql(from), ["kept"])
    const bare = { ...base, nodes: { ...base.nodes, "model.shop.orders_copy": other, "model.shop.rpt_join": child("fct_orders a join fct_orders b on a.order_id = b.order_id") } }
    const ambiguous = columnReach(manifestFile(bare), "fct_orders", "revenue")
    expect(ambiguous.models.map((m) => m.name)).not.toContain("rpt_join")
    expect(ambiguous.uncertain.find((m) => m.name === "rpt_join")?.reason).toBe("reads a parent whose table name another parent shares")

    // Only archive.fct_orders (not traced) is read: no reader.
    const qualified = { ...base, nodes: { ...base.nodes, "model.shop.orders_copy": other, "model.shop.rpt_join": child("main.fct_orders a join archive.fct_orders b on a.order_id = b.order_id") } }
    const reach = columnReach(manifestFile(qualified), "fct_orders", "revenue")
    expect(reach.models.map((m) => m.name)).not.toContain("rpt_join")
  })

  test("a snapshot is traced and carries the column on", () => {
    const value = manifest()
    value.nodes["snapshot.shop.snap_orders"] = { ...model("snap_orders", ["model.shop.fct_orders"], "select order_id, revenue from fct_orders", ["order_id", "revenue"]), resource_type: "snapshot", unique_id: "snapshot.shop.snap_orders" }
    value.nodes["model.shop.rpt_snap"] = model("rpt_snap", ["snapshot.shop.snap_orders"], "select sum(revenue) as snap_revenue from snap_orders", ["snap_revenue"])
    const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
    const byName = Object.fromEntries(reach.models.map((m) => [m.name, m.columns]))
    expect(byName.snap_orders).toEqual(["revenue"])
    expect(byName.rpt_snap).toEqual(["snap_revenue"])
  })

  test("a column no downstream model reads reaches nothing", () => {
    const reach = columnReach(manifestFile(), "fct_orders", "gross_revenue")
    expect(reach.models).toEqual([])
    expect(reach.exposures).toEqual([])
  })

  test("an unknown model or a missing manifest throws", () => {
    expect(() => columnReach(manifestFile(), "nope", "revenue")).toThrow(/not found/)
    expect(() => columnReach(join(tmpdir(), "no-such-manifest.json"), "fct_orders", "revenue")).toThrow(/Manifest not found/)
  })
})

describe("exposuresOn", () => {
  test("lists exposures on any of the given nodes, by label when there is one", () => {
    const file = manifestFile()
    expect(exposuresOn(file, ["model.shop.rpt_counts"])).toEqual([{ unique_id: "exposure.shop.ops", name: "ops", label: "ops", type: "application" }])
    expect(exposuresOn(file, ["model.shop.fct_orders"])).toEqual([])
  })
})

describe("parentsNamed", () => {
  test("a qualified name matches the parent at that qualification only; a bare name matches every parent that answers to it", () => {
    const nodes: Record<string, any> = {
      a: { alias: "orders", schema: "main", database: "shop" },
      b: { alias: "orders", schema: "archive", database: "shop" },
    }
    const lookup = (id: string) => nodes[id]
    expect(parentsNamed(["shop", "main", "orders"], ["a", "b"], lookup)).toEqual(["a"])
    expect(parentsNamed(["archive", "orders"], ["a", "b"], lookup)).toEqual(["b"])
    expect(parentsNamed(["orders"], ["a", "b"], lookup)).toEqual(["a", "b"])
    expect(parentsNamed(["raw", "orders"], ["a", "b"], lookup)).toEqual([])
  })
})

describe("columnReach where the engine's schema falls short", () => {
  test("select * from a parent whose schema.yml does not list the column is a possible read, and its children may read it", () => {
    const value = manifest()
    value.nodes["model.shop.fct_orders"].columns = { order_id: column("order_id") }
    value.nodes["model.shop.rpt_star"] = model("rpt_star", ["model.shop.fct_orders"], 'select * from "shop"."main"."fct_orders"', [])
    value.nodes["model.shop.rpt_after_star"] = model("rpt_after_star", ["model.shop.rpt_star"], "select sum(revenue) as total from rpt_star", ["total"])
    const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
    expect(reach.uncertain.find((m) => m.name === "rpt_star")?.reason).toBe("selects * from a parent whose schema.yml does not list the column")
    expect(reach.uncertain.map((m) => m.name)).toContain("rpt_after_star")
  })

  test("a dashboard downstream of a wildcard reader in any dialect form is reported, not dropped", () => {
    for (const sql of ["select distinct on (order_id) * from fct_orders", "select top 10 * from fct_orders", 'select "shop"."main"."fct_orders".* from "shop"."main"."fct_orders"']) {
      const value: any = manifest()
      value.nodes["model.shop.fct_orders"].columns = { order_id: column("order_id") }
      value.nodes["model.shop.rpt_star"] = model("rpt_star", ["model.shop.fct_orders"], sql, [])
      value.exposures["exposure.shop.star_board"] = { name: "star_board", label: "Star Board", type: "dashboard", depends_on: { nodes: ["model.shop.rpt_star"] } }
      const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
      expect(reach.uncertain.map((m) => m.name)).toContain("rpt_star")
      expect(reach.uncertain_exposures.map((e) => e.label)).toContain("Star Board")
    }
  })

  test("a column name with a dot, quoted, is matched whole", () => {
    const value = manifest()
    value.nodes["model.shop.fct_orders"].columns = { "net.amount": column("net.amount") }
    value.nodes["model.shop.rpt_net"] = model("rpt_net", ["model.shop.fct_orders"], 'select "net.amount" as net from fct_orders', ["net"])
    const reach = columnReach(manifestFile(value), "fct_orders", "net.amount")
    expect(reach.models.find((m) => m.name === "rpt_net")?.columns).toEqual(["net"])
  })
})

describe("selectsStar", () => {
  test("a CR-terminated line comment does not hide the SQL after it", () => {
    expect(selectsStar("select 1 -- note\rfrom t where x = 1 and y = (select *\rfrom u)")).toBe(true)
  })

  test("finds * and t.* in a select list, not multiplication or count(*)", () => {
    for (const sql of [
      "select * from a",
      "select*from a",
      "select a.*, b.x from a",
      "select x, t.* from t",
      "select distinct * from a",
      "select /* c */ * from a",
      "select all * from a",
      "select * exclude (order_id) from a",
      "select * except (order_id) from a",
      "select a . * from a",
      "select distinct on (customer_id) * from a",
      "select analytics.dbt_x.orders.* from analytics.dbt_x.orders",
      '"db"."sch"."orders".* ',
      "select top 10 * from a",
      "select as struct * from a",
      'select "my col".* from t',
      "select * replace (1 as x) from a",
    ])
      expect(selectsStar(sql)).toBe(true)
    for (const sql of [
      "select revenue * 100 as cents from a",
      "select count(*) as n from a",
      "select a, b*c as d from t",
      "select '*' as s from a",
      "select (a + b) * c as d from t",
      "select a * (b + c) as d from t",
      "select x from a -- select *",
      "select revenue * -1 as x from t",
      "select a*-1 as x from t",
      "select a * + b as x from t",
      "select a * - (b + c) as x from t",
      "select $$ * $$ as s from a",
      "select $q$ select * $q$ as s from a",
    ])
      expect(selectsStar(sql)).toBe(false)
    // A function over the whole row reads every column; only count(*) reads none.
    for (const sql of ["select id, hash(*) as h from a", "select object_construct(*) as o from a", "select to_json(struct(*)) as j from a", "select columns(*) from a"])
      expect(selectsStar(sql)).toBe(true)
  })
})

describe("columnReach through an ephemeral parent", () => {
  test("a model reading an ephemeral parent is a possible read, never a silent zero", () => {
    const value = manifest()
    value.nodes["model.shop.eph"] = { ...model("eph", ["model.shop.fct_orders"], "select order_id, revenue from fct_orders", ["order_id", "revenue"]), config: { materialized: "ephemeral" } }
    value.nodes["model.shop.rpt_eph"] = model(
      "rpt_eph",
      ["model.shop.eph"],
      "with __dbt__cte__eph as (select order_id, revenue from fct_orders) select sum(revenue) as total from __dbt__cte__eph",
      ["total"],
    )
    const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
    expect(reach.models.map((m) => m.name)).toContain("eph")
    expect(reach.uncertain.find((m) => m.name === "rpt_eph")?.reason).toBe(
      "reads an ephemeral parent, inlined as a CTE the lineage engine cannot trace through",
    )
  })
})

describe("columnReach with an ephemeral and a regular parent", () => {
  test("a traced edge from the regular parent does not hide what flows through the ephemeral one", () => {
    const value = manifest()
    value.nodes["model.shop.eph"] = { ...model("eph", ["model.shop.fct_orders"], "select order_id, revenue as renamed from fct_orders", ["order_id", "renamed"]), config: { materialized: "ephemeral" } }
    value.nodes["model.shop.mix"] = model(
      "mix",
      ["model.shop.fct_daily", "model.shop.eph"],
      "with __dbt__cte__eph as (select order_id, revenue as renamed from fct_orders) select d.revenue as direct, e.renamed as hidden from fct_daily d cross join __dbt__cte__eph e",
      ["direct", "hidden"],
    )
    value.nodes["model.shop.leaf"] = model("leaf", ["model.shop.mix"], "select max(hidden) as h from mix", ["h"])
    const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
    expect(reach.models.map((m) => m.name)).toContain("mix")
    expect(reach.uncertain.map((m) => m.name)).toContain("leaf")
  })
})

describe("columnReach with columns that differ only by case", () => {
  test('"Revenue" is not revenue where the parent documents both', () => {
    const value: any = manifest()
    value.nodes["model.shop.fct_orders"].columns = { revenue: column("revenue"), Revenue: column("Revenue") }
    value.nodes["model.shop.rpt_case"] = model("rpt_case", ["model.shop.fct_orders"], 'select "Revenue" as other from fct_orders', ["other"])
    const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
    expect(reach.models.map((m) => m.name)).not.toContain("rpt_case")
    expect(reach.models.map((m) => m.name)).toContain("fct_daily")
  })
})

describe("columnReach case handling", () => {
  test("a spelling matching one documented column ignoring case reaches its readers", () => {
    const reach = columnReach(manifestFile(), "fct_orders", "REVENUE")
    expect(reach.models.map((m) => m.name)).toContain("fct_daily")
  })

  test("a spelling matching two columns that differ only by case leaves both columns' readers uncertain, never certain", () => {
    const value: any = manifest()
    value.nodes["model.shop.fct_orders"].columns = { revenue: column("revenue"), Revenue: column("Revenue") }
    value.nodes["model.shop.rpt_case"] = model("rpt_case", ["model.shop.fct_orders"], 'select "Revenue" as other from fct_orders', ["other"])
    const reach = columnReach(manifestFile(value), "fct_orders", "REVENUE")
    expect(reach.models.map((m) => m.name)).not.toContain("fct_daily")
    expect(reach.models.map((m) => m.name)).not.toContain("rpt_case")
    expect(reach.uncertain.map((m) => m.name)).toEqual(expect.arrayContaining(["fct_daily", "rpt_case"]))
  })

  test("with the spelling unsettled, a dashboard on the model itself is uncertain too", () => {
    const value: any = manifest()
    value.nodes["model.shop.fct_orders"].columns = { revenue: column("revenue"), Revenue: column("Revenue") }
    value.exposures["exposure.shop.orders_board"] = { name: "orders_board", type: "dashboard", depends_on: { nodes: ["model.shop.fct_orders"] } }
    const reach = columnReach(manifestFile(value), "fct_orders", "REVENUE")
    expect(reach.exposures.map((e) => e.unique_id)).not.toContain("exposure.shop.orders_board")
    expect(reach.uncertain_exposures.map((e) => e.unique_id)).toContain("exposure.shop.orders_board")
  })
})

describe("columnReach with an empty column_lineage", () => {
  test("falls back to column_dict edges", () => {
    const spy = spyOn(core, "columnLineage").mockImplementation((() => ({
      column_lineage: [],
      column_dict: { revenue: ['"shop"."main"."fct_orders"."revenue"'] },
    })) as any)
    try {
      const reach = columnReach(manifestFile(), "fct_orders", "revenue")
      expect(reach.models.find((m) => m.name === "fct_daily")?.columns).toEqual(["revenue"])
    } finally {
      spy.mockRestore()
    }
  })
})

describe("columnReach on SQL the engine cannot parse", () => {
  test("is untraced, and a dashboard on it is reported apart", () => {
    const value = manifest()
    value.nodes["model.shop.fct_daily"].compiled_code = "select sum(revenue) as revenue frm fct_orders whre"
    const reach = columnReach(manifestFile(value), "fct_orders", "revenue")
    expect(reach.untraced.map((m) => m.name)).toEqual(["fct_daily"])
    expect(reach.untraced[0]!.reason).toContain("Parse error")
    expect(reach.exposures).toEqual([])
    expect(reach.uncertain_exposures).toEqual([{ unique_id: "exposure.shop.exec_revenue", name: "exec_revenue", label: "Exec Revenue", type: "dashboard" }])
  })
})

describe("lineageGraph", () => {
  test("a twelve-hop chain comes back whole to its source; upstream past 500 nodes is cut and marked", () => {
    const chain: Record<string, any> = {}
    for (let i = 1; i <= 12; i++) chain[`model.shop.m${i}`] = model(`m${i}`, [i === 1 ? "source.shop.raw.orders" : `model.shop.m${i - 1}`], "select 1", [])
    chain["test.shop.m3_unique"] = { resource_type: "test", name: "m3_unique", depends_on: { nodes: ["model.shop.m3"] } }
    const graph = lineageGraph({ nodes: chain, sources: { "source.shop.raw.orders": { resource_type: "source", name: "orders", source_name: "raw" } } }, "model.shop.m12")
    // An upstream model's tests are left out: only the target's and downstream tests are counted.
    expect(graph.nodes["test.shop.m3_unique"]).toBeUndefined()
    expect(graph.nodes["source.shop.raw.orders"]).toBeDefined()
    expect(Object.keys(graph.nodes)).toHaveLength(13)
    expect(graph.upTruncated).toBe(false)

    const wide: Record<string, any> = { "model.shop.top": model("top", Array.from({ length: 600 }, (_, i) => `model.shop.p${i}`), "select 1", []) }
    for (let i = 0; i < 600; i++) wide[`model.shop.p${i}`] = model(`p${i}`, [], "select 1", [])
    const cut = lineageGraph({ nodes: wide }, "model.shop.top")
    expect(cut.upTruncated).toBe(true)
    expect(Object.keys(cut.nodes)).toHaveLength(501)
  })

  test("downstream past 500 nodes is cut and marked; downstream tests are still counted", () => {
    const wide: Record<string, any> = { "model.shop.top": model("top", [], "select 1", []) }
    for (let i = 0; i < 600; i++) wide[`model.shop.c${i}`] = model(`c${i}`, ["model.shop.top"], "select 1", [])
    wide["test.shop.top_unique"] = { resource_type: "test", name: "top_unique", depends_on: { nodes: ["model.shop.top"] } }
    wide["test.shop.c0_unique"] = { resource_type: "test", name: "c0_unique", depends_on: { nodes: ["model.shop.c0"] } }
    const cut = lineageGraph({ nodes: wide }, "model.shop.top")
    expect(cut.truncated).toBe(true)
    expect(cut.upTruncated).toBe(false)
    const kept = Object.values(cut.nodes)
    expect(kept.filter((n) => n.type !== "test")).toHaveLength(501)
    expect(kept.filter((n) => n.type === "test").map((n) => n.id).sort()).toEqual(["test.shop.c0_unique", "test.shop.top_unique"])
  })

  test("everything up and downstream, tests as ids, from dbt's child_map when present", () => {
    const value = {
      ...manifest(),
      nodes: { ...manifest().nodes, "test.shop.t1": { resource_type: "test", name: "t1", depends_on: { nodes: ["model.shop.fct_daily"] } } },
    }
    const graph = lineageGraph(value, "model.shop.mart_ltv")
    expect(graph.parents["model.shop.mart_ltv"]).toEqual(["model.shop.fct_orders"])
    expect(graph.children["model.shop.mart_ltv"]).toEqual(["model.shop.rpt_ltv"])
    expect(graph.nodes["model.shop.mart_ltv"]).toEqual({
      id: "model.shop.mart_ltv",
      name: "mart_ltv",
      label: null,
      type: "model",
      path: "models/mart_ltv.sql",
      materialized: null,
      relation: "shop.main.mart_ltv",
      columns: ["order_id", "ltv"],
    })
    expect(graph.truncated).toBe(false)
    const fromFct = lineageGraph({ ...value, child_map: { "model.shop.fct_orders": ["model.shop.fct_daily", "test.shop.t1"], "model.shop.fct_daily": [] }, parent_map: { "model.shop.fct_orders": [], "test.shop.t1": ["model.shop.fct_orders"] } }, "model.shop.fct_orders")
    expect(Object.keys(fromFct.nodes).sort()).toEqual(["model.shop.fct_daily", "model.shop.fct_orders", "test.shop.t1"])
    expect(fromFct.nodes["test.shop.t1"]!.type).toBe("test")
    expect(fromFct.parents["test.shop.t1"]).toEqual(["model.shop.fct_orders"])
    expect(fromFct.children["test.shop.t1"]).toEqual([])
  })

  test("a node whose manifest relation_name is null has no relation", () => {
    const base = manifest()
    const value = {
      ...base,
      nodes: { ...base.nodes, "model.shop.mart_ltv": { ...base.nodes["model.shop.mart_ltv"], relation_name: null } },
    }
    expect(lineageGraph(value, "model.shop.mart_ltv").nodes["model.shop.mart_ltv"]!.relation).toBeNull()
  })
})

describe("structuredError", () => {
  test("passes a short message and caps a huge one", () => {
    expect(structuredError("boom")).toEqual({ report: "boom" })
    const out = structuredError("x".repeat(300_000))
    expect(out.truncated).toBe(true)
    expect(Buffer.byteLength(out.report as string)).toBeLessThanOrEqual(100_000)
  })
  test("exposures_error reaches the structured fields", () => {
    expect(structuredResult("impact_analysis", { exposures_error: "bad json" }, "R")).toEqual({ exposures_error: "bad json", report: "R" })
  })
})

describe("structuredResult over the cap", () => {
  test("a report too big on its own is shortened too", () => {
    const out = structuredResult("dbt_lineage", { structuredContent: { focus: {} } }, "x".repeat(300_000))
    expect(out.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(100_000)
    expect("x".repeat(300_000).startsWith(out.report as string)).toBe(true)
  })
})

describe("structuredError escaping", () => {
  test("the cap holds for the serialized result, whatever JSON escaping adds", () => {
    for (const text of ["\n".repeat(100_000), "\u0000".repeat(300_000), "é".repeat(80_000)]) {
      const out = structuredError(text)
      expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(100_000)
      expect(out.truncated).toBe(true)
    }
  })
})


describe("structuredResult", () => {
  test("passes the lineage fields with the report, and only the report when they are too big", () => {
    expect(structuredResult("impact_analysis", { severity: "LOW", findings: [{ category: "x" }], downstream: [] }, "Impact")).toEqual({
      severity: "LOW",
      downstream: [],
      report: "Impact",
    })
    const huge = { edges: Array.from({ length: 5000 }, (_, i) => ({ source: `"t"."c${i}"`, target: `c${i}` })) }
    expect(structuredResult("dbt_lineage", huge, "Model: x")).toEqual({ report: "Model: x", truncated: true })
    // dbt_lineage's text repeats the columns and edges: only its header goes with them.
    expect(structuredResult("dbt_lineage", { columns: {}, edges: [], graph: { nodes: {} } }, "Model: x\nID: y\n\nColumn Mappings:\n  a ← [\"t.a\"]")).toEqual({
      columns: {},
      edges: [],
      report: "Model: x\nID: y",
    })
    // With no column_dict the text has no Column Mappings section: the edges are cut at their own header.
    expect(structuredResult("dbt_lineage", { columns: {}, edges: [] }, "Model: x\nID: y\n\nLineage Edges:\n  {}")).toEqual({
      columns: {},
      edges: [],
      report: "Model: x\nID: y",
    })
  })
})

describe("dbtLineage", () => {
  test("reports the model's upstream unique_ids, and the graph when asked", () => {
    const file = manifestFile()
    const result = dbtLineage({ manifest_path: file, model: "mart_ltv" })
    expect(result.upstream).toEqual(["model.shop.fct_orders"])
    expect(result.graph).toBeUndefined()
    expect(Object.keys(dbtLineage({ manifest_path: file, model: "mart_ltv", include_graph: true }).graph!.nodes)).toContain("model.shop.rpt_ltv")
    // By project-relative path too.
    expect(dbtLineage({ manifest_path: file, model: "models/mart_ltv.sql" }).model_unique_id).toBe("model.shop.mart_ltv")
    const withSnapshot: any = manifest()
    withSnapshot.nodes["snapshot.shop.snap"] = { ...model("snap", ["model.shop.fct_orders"], "select order_id from fct_orders", ["order_id"]), resource_type: "snapshot", unique_id: "snapshot.shop.snap" }
    expect(dbtLineage({ manifest_path: manifestFile(withSnapshot), model: "snap" }).model_unique_id).toBe("snapshot.shop.snap")
    // A snapshot named like another node's unique_id keeps its own id.
    withSnapshot.nodes["test.shop.t1"] = { resource_type: "test", name: "t1", depends_on: { nodes: [] } }
    withSnapshot.nodes["snapshot.shop.odd"] = { ...withSnapshot.nodes["snapshot.shop.snap"], unique_id: "snapshot.shop.odd", name: "test.shop.t1" }
    expect(dbtLineage({ manifest_path: manifestFile(withSnapshot), model: "test.shop.t1" }).model_unique_id).toBe("snapshot.shop.odd")
  })
})
