// altimate_change - new file
//
// dbt_sql_graph: the request built from the compiled model and its parents' columns, and the
// remap of the backend's reply (`__final_select__` to the model's node, relation nodes to dbt unique ids).
// The adapter and the endpoint are fakes, so no dbt, warehouse or backend is involved.
import { describe, expect, test } from "bun:test"
import {
  buildSqlGraph,
  formatSqlGraph,
  mergeColumns,
  remapSqlLineage,
  type SqlGraphAdapter,
} from "@/altimate/tools/dbt-sql-graph"
import type { SqlLineageRequest, SqlLineageResponse } from "@/altimate/api/sql-lineage"

const col = (name: string, data_type = "") => ({ name, description: "", data_type, meta: {} })

const orders = {
  unique_id: "model.shop.orders",
  name: "orders",
  alias: "orders",
  resource_type: "model",
  path: "/proj/models/orders.sql",
  database: "db",
  schema: "analytics",
  columns: {},
}
const stgCustomers = {
  unique_id: "model.shop.stg_customers",
  name: "stg_customers",
  alias: "stg_customers",
  resource_type: "model",
  path: "/proj/models/stg_customers.sql",
  database: "db",
  schema: "analytics",
  columns: { id: col("id", "int") },
}
const rawOrders = {
  name: "raw",
  database: "db",
  schema: "raw",
  tables: [{ name: "raw_orders", identifier: "RAW_ORDERS_T", columns: {} }],
}

function adapter(overrides: Partial<SqlGraphAdapter> = {}): SqlGraphAdapter & { calls: string[] } {
  const calls: string[] = []
  const nodes = [orders, stgCustomers]
  return {
    calls,
    parseManifest: async () => ({
      nodeMetaMap: {
        lookupByUniqueId: (id) => nodes.find((n) => n.unique_id === id),
        lookupByBaseName: (name) => nodes.find((n) => n.name === name),
      },
      sourceMetaMap: { get: (name) => (name === "raw" ? rawOrders : undefined) },
    }),
    unsafeCompileQuery: async (q) => {
      calls.push(`compile:${q}`)
      return "with o as (select * from raw.orders) select * from o join stg_customers c on 1=1"
    },
    getNonEphemeralParents: () => ["source.shop.raw.raw_orders", "model.shop.stg_customers"],
    getBulkSchemaFromDB: async (requested) => {
      calls.push(`schema:${requested.map((r) => r.unique_id).join(",")}`)
      return {
        "source.shop.raw.raw_orders": [
          { column: "ID", dtype: "INT" },
          { column: "AMOUNT", dtype: "NUMBER" },
        ],
        "model.shop.stg_customers": [
          { column: "ID", dtype: "INT" },
          { column: "NAME", dtype: "TEXT" },
        ],
      }
    },
    getAdapterType: () => "snowflake",
    ...overrides,
  }
}

const reply: SqlLineageResponse = {
  tableEdges: [
    ["raw_orders", "o"],
    ["o", "__final_select__"],
    ["stg_customers", "__final_select__"],
  ],
  details: {
    raw_orders: { name: "raw_orders", type: "table", sql: "", columns: [{ name: "id" }, { name: "amount" }] },
    o: { name: "o", type: "cte", sql: "select * from raw.orders", columns: [{ name: "id" }] },
    stg_customers: { name: "stg_customers", type: "table", sql: "", columns: [{ name: "id" }, { name: "name" }] },
    __final_select__: { name: "__final_select__", type: "final", sql: "select * from o", columns: [{ name: "id" }] },
  },
  nodePositions: { o: [1, 1], __final_select__: [2, 2] },
}

const signal = new AbortController().signal

describe("mergeColumns", () => {
  test("adds warehouse columns the manifest lacks, lower-cased, and fills a missing type", () => {
    const merged = mergeColumns(
      { id: col("id") },
      [
        { column: "ID", dtype: "INT" },
        { column: "NEW_ONE", dtype: "TEXT" },
      ],
      "snowflake",
    )
    expect(Object.keys(merged)).toEqual(["id", "new_one"])
    expect(merged.id.data_type).toBe("int")
    expect(merged.new_one).toEqual({ name: "new_one", data_type: "text", description: "", meta: {} })
  })

  test("keeps a quoted name as written and tolerates no warehouse answer", () => {
    expect(Object.keys(mergeColumns({}, [{ column: '"MixedCase"', dtype: "int" }], "snowflake"))).toEqual([
      '"MixedCase"',
    ])
    expect(mergeColumns({ a: col("a", "int") }, undefined, "snowflake").a.data_type).toBe("int")
  })

  test("a name outside the adapter's folding case stays distinct: Postgres Foo and foo, Snowflake Foo and FOO", () => {
    const pg = mergeColumns(
      {},
      [
        { column: "Foo", dtype: "int" },
        { column: "foo", dtype: "text" },
      ],
      "postgres",
    )
    expect(Object.keys(pg)).toEqual(["Foo", "foo"])
    expect(pg.Foo.data_type).toBe("int")
    expect(pg.foo.data_type).toBe("text")
    const sf = mergeColumns(
      {},
      [
        { column: "Foo", dtype: "int" },
        { column: "FOO", dtype: "text" },
      ],
      "snowflake",
    )
    expect(Object.keys(sf)).toEqual(["Foo", "foo"])
  })

  test("a manifest column and the warehouse's name for it meet under one key in the adapter's case", () => {
    const merged = mergeColumns({ id: col("id") }, [{ column: "id", dtype: "BIGINT" }], "postgres")
    expect(Object.keys(merged)).toEqual(["id"])
    expect(merged.id.data_type).toBe("bigint")
  })

  test("columns named like Object members are columns, and nothing is written to the built-ins", () => {
    const merged = mergeColumns(
      {},
      [
        { column: "constructor", dtype: "text" },
        { column: "__proto__", dtype: "int" },
      ],
      "postgres",
    )
    expect(Object.keys(merged)).toEqual(["constructor", "__proto__"])
    expect(Object.getOwnPropertyDescriptor(merged, "constructor")?.value.data_type).toBe("text")
    expect((Object.prototype as any).data_type).toBeUndefined()
    expect((Object as any).data_type).toBeUndefined()
  })
})

describe("remapSqlLineage", () => {
  const parents = [
    { uniqueId: "source.shop.raw.raw_orders", sourceTable: "raw_orders", resourceType: "source" },
    { uniqueId: "model.shop.stg_customers", alias: "STG_CUSTOMERS", resourceType: "model" },
  ]
  const graph = remapSqlLineage(
    reply,
    { name: "orders", uniqueId: "model.shop.orders", resourceType: "model" },
    parents,
  )

  test("renames __final_select__ to the model in edges and nodes", () => {
    expect(graph.edges).toEqual([
      ["raw_orders", "o"],
      ["o", "orders"],
      ["stg_customers", "orders"],
    ])
    expect(graph.nodes.map((n) => n.name)).toEqual(["raw_orders", "o", "stg_customers", "orders"])
    expect(JSON.stringify(graph)).not.toContain("__final_select__")
  })

  test("ties table nodes to dbt unique ids, case-insensitively, and the model to itself", () => {
    const byName = Object.fromEntries(graph.nodes.map((n) => [n.name, n]))
    expect(byName.raw_orders).toMatchObject({ nodeId: "source.shop.raw.raw_orders", type: "source" })
    expect(byName.stg_customers).toMatchObject({ nodeId: "model.shop.stg_customers", type: "model" })
    expect(byName.orders).toMatchObject({ nodeId: "model.shop.orders", type: "model", sql: "select * from o" })
  })

  test("leaves CTEs unmapped and drops the layout positions", () => {
    const cte = graph.nodes.find((n) => n.name === "o")!
    expect(cte).toEqual({ name: "o", type: "cte", sql: "select * from raw.orders", columns: [{ name: "id" }] })
    expect(graph).not.toHaveProperty("nodePositions")
  })

  test("a CTE or table named like the model keeps its node; the model's own select is told apart", () => {
    const collide: SqlLineageResponse = {
      tableEdges: [
        ["stg_customers", "orders"],
        ["orders", "__final_select__"],
      ],
      details: {
        stg_customers: { name: "stg_customers", type: "table", sql: "", columns: [] },
        orders: { name: "orders", type: "cte", sql: "select * from stg_customers", columns: [{ name: "id" }] },
        __final_select__: { name: "__final_select__", type: "final", sql: "select * from orders", columns: [] },
      },
    }
    const out = remapSqlLineage(collide, { name: "orders", uniqueId: "model.shop.orders", resourceType: "model" }, [])
    expect(out.edges).toEqual([
      ["stg_customers", "orders"],
      ["orders", "orders (final select)"],
    ])
    expect(out.nodes).toEqual([
      { name: "stg_customers", type: "table", sql: "", columns: [] },
      { name: "orders", type: "cte", sql: "select * from stg_customers", columns: [{ name: "id" }] },
      {
        name: "orders (final select)",
        type: "model",
        nodeId: "model.shop.orders",
        sql: "select * from orders",
        columns: [],
      },
    ])
  })

  test("a source table named like the model stays the source's node; a model named like an Object member is not renamed", () => {
    const sameName: SqlLineageResponse = {
      tableEdges: [["orders", "__final_select__"]],
      details: {
        orders: { name: "orders", type: "table", sql: "", columns: [] },
        __final_select__: { name: "__final_select__", type: "final", sql: "select * from orders", columns: [] },
      },
    }
    const parentsOf = [{ uniqueId: "source.shop.raw.orders", sourceTable: "orders", resourceType: "source" }]
    const out = remapSqlLineage(
      sameName,
      { name: "orders", uniqueId: "model.shop.orders", resourceType: "model" },
      parentsOf,
    )
    expect(out.nodes.map((n) => [n.name, n.nodeId])).toEqual([
      ["orders", "source.shop.raw.orders"],
      ["orders (final select)", "model.shop.orders"],
    ])
    const member = remapSqlLineage(
      { tableEdges: [["x", "__final_select__"]], details: { __final_select__: sameName.details.__final_select__ } },
      { name: "constructor", uniqueId: "model.shop.constructor", resourceType: "model" },
      [],
    )
    expect(member.nodes.map((n) => n.name)).toEqual(["constructor"])
    expect(member.edges).toEqual([["x", "constructor"]])
  })

  test("does not mutate the backend reply", () => {
    expect(reply.details.__final_select__).toBeDefined()
    expect(reply.tableEdges[1]).toEqual(["o", "__final_select__"])
  })
})

describe("buildSqlGraph", () => {
  const read = (file: string) => `-- ${file}\nselect 1`

  test("sends the compiled SQL, parents' merged columns and dialect, then remaps the reply", async () => {
    const a = adapter()
    let sent: SqlLineageRequest | undefined
    const graph = await buildSqlGraph(
      a,
      "orders",
      {
        fetchLineage: async (req) => {
          sent = req
          return reply
        },
        readFile: read,
        projectRoot: "/proj",
        sessionId: "ses_1",
      },
      signal,
    )
    expect(a.calls).toEqual([
      "compile:-- /proj/models/orders.sql\nselect 1",
      "schema:source.shop.raw.raw_orders,model.shop.stg_customers",
    ])
    expect(sent?.model_dialect).toBe("snowflake")
    expect(sent?.compiled_sql).toContain("join stg_customers")
    expect(sent?.session_id).toMatch(/^ses_1-[0-9a-f]{32}$/)
    expect(sent?.model_info).toEqual([
      {
        model_node: {
          database: "db",
          schema: "raw",
          name: "raw_orders",
          alias: "RAW_ORDERS_T",
          uniqueId: "source.shop.raw.raw_orders",
          columns: {
            id: { name: "id", data_type: "int", description: "", meta: {} },
            amount: { name: "amount", data_type: "number", description: "", meta: {} },
          },
          path: undefined,
        },
      },
      {
        model_node: {
          database: "db",
          schema: "analytics",
          name: "stg_customers",
          alias: "stg_customers",
          uniqueId: "model.shop.stg_customers",
          columns: {
            id: { name: "id", description: "", data_type: "int", meta: {} },
            name: { name: "name", data_type: "text", description: "", meta: {} },
          },
          path: "/proj/models/stg_customers.sql",
        },
      },
    ])
    expect(graph.edges).toContainEqual(["o", "orders"])
    expect(graph.nodes.find((n) => n.name === "orders")?.nodeId).toBe("model.shop.orders")
    expect(graph.nodes.find((n) => n.name === "raw_orders")?.nodeId).toBe("source.shop.raw.raw_orders")
  })

  test("accepts a unique_id and resolves a project-relative path against the project root", async () => {
    const relative = { ...orders, path: "models/orders.sql" }
    const a = adapter({
      parseManifest: async () => ({
        nodeMetaMap: {
          lookupByUniqueId: (id) => (id === relative.unique_id ? relative : undefined),
          lookupByBaseName: () => undefined,
        },
        sourceMetaMap: { get: () => undefined },
      }),
      getNonEphemeralParents: () => [],
    })
    let read: string | undefined
    await buildSqlGraph(
      a,
      "model.shop.orders",
      {
        fetchLineage: async () => reply,
        readFile: (f) => ((read = f), "select 1"),
        projectRoot: "/proj",
        sessionId: "ses_1",
      },
      signal,
    )
    expect(read).toBe("/proj/models/orders.sql")
    // no parents: no warehouse read
    expect(a.calls.some((c) => c.startsWith("schema:"))).toBe(false)
  })

  test("an unknown model, an uncompilable model and a missing manifest each fail with a reason", async () => {
    const deps = { fetchLineage: async () => reply, readFile: read, projectRoot: "/proj", sessionId: "ses_1" }
    await expect(buildSqlGraph(adapter(), "nope", deps, signal)).rejects.toThrow("no model named nope")
    await expect(
      buildSqlGraph(adapter({ unsafeCompileQuery: async () => undefined }), "orders", deps, signal),
    ).rejects.toThrow("unable to compile orders")
    await expect(
      buildSqlGraph(adapter({ parseManifest: async () => undefined }), "orders", deps, signal),
    ).rejects.toThrow("manifest is not available")
  })

  test("a seed, a snapshot or a model with no .sql file is refused before anything is compiled", async () => {
    const deps = { fetchLineage: async () => reply, readFile: read, projectRoot: "/proj", sessionId: "ses_1" }
    for (const odd of [
      { ...orders, name: "countries", resource_type: "seed", path: "seeds/countries.csv" },
      { ...orders, name: "snap", resource_type: "snapshot", path: "snapshots/snap.sql" },
      { ...orders, name: "py_model", path: "models/py_model.py" },
    ]) {
      const a = adapter({
        parseManifest: async () => ({
          nodeMetaMap: { lookupByUniqueId: () => undefined, lookupByBaseName: () => odd },
          sourceMetaMap: { get: () => undefined },
        }),
      })
      await expect(buildSqlGraph(a, odd.name, deps, signal)).rejects.toThrow(`${odd.name} is not a dbt model`)
      expect(a.calls).toEqual([])
    }
  })

  test("a cancel while the manifest parses or the model compiles starts no further work", async () => {
    const deps = { fetchLineage: async () => reply, readFile: read, projectRoot: "/proj", sessionId: "ses_1" }
    const duringParse = new AbortController()
    const a = adapter()
    const parse = a.parseManifest
    a.parseManifest = async () => {
      const manifest = await parse()
      duringParse.abort()
      return manifest
    }
    await expect(buildSqlGraph(a, "orders", deps, duringParse.signal)).rejects.toThrow()
    expect(a.calls).toEqual([])

    const duringCompile = new AbortController()
    const b = adapter({
      unsafeCompileQuery: async () => {
        duringCompile.abort()
        return "select 1"
      },
    })
    await expect(buildSqlGraph(b, "orders", deps, duringCompile.signal)).rejects.toThrow()
    expect(b.calls).toEqual([])
  })

  test("two sessions asking for the same SQL send different session ids", async () => {
    const ids: string[] = []
    const fetchLineage = async (req: SqlLineageRequest) => (ids.push(req.session_id), reply)
    const base = { fetchLineage, readFile: read, projectRoot: "/proj" }
    await buildSqlGraph(adapter(), "orders", { ...base, sessionId: "ses_a" }, signal)
    await buildSqlGraph(adapter(), "orders", { ...base, sessionId: "ses_b" }, signal)
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[0]?.split("-").slice(-1)[0]).toBe(ids[1]?.split("-").slice(-1)[0])
  })

  test("a backend failure propagates and sends nothing after a cancel", async () => {
    const deps = {
      fetchLineage: async () => {
        throw new Error("API POST /dbt/v3/sql_lineage failed with status 500")
      },
      readFile: read,
      projectRoot: "/proj",
      sessionId: "ses_1",
    }
    await expect(buildSqlGraph(adapter(), "orders", deps, signal)).rejects.toThrow("status 500")
    const aborted = AbortSignal.abort()
    let called = false
    await expect(
      buildSqlGraph(adapter(), "orders", { ...deps, fetchLineage: async () => ((called = true), reply) }, aborted),
    ).rejects.toThrow()
    expect(called).toBe(false)
  })
})

describe("formatSqlGraph", () => {
  test("lists each node with its inputs and column count", () => {
    const graph = remapSqlLineage(reply, { name: "orders", uniqueId: "model.shop.orders", resourceType: "model" }, [])
    const text = formatSqlGraph("orders", graph)
    expect(text).toContain("4 nodes, 3 edges")
    expect(text).toContain("- orders (model, model.shop.orders): 1 columns, from o, stg_customers")
    expect(text).toContain("- o (cte): 1 columns, from raw_orders")
  })
})
