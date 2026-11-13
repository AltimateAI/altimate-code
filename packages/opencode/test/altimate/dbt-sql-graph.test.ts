// altimate_change - new file
//
// dbt_sql_graph: the request built from the compiled model and its parents' columns, and the
// remap of the backend's reply (`__final_select__` to the model's node, relation nodes to dbt unique ids).
// The adapter and the endpoint are fakes, so no dbt, warehouse or backend is involved.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { SessionID, MessageID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { dbtAdapterInternals, resetDbtAdapter } from "@/altimate/native/connections/register"
import { initTool } from "./tool-fixture"
import {
  buildSqlGraph,
  formatSqlGraph,
  mergeColumns,
  remapSqlLineage,
  DbtSqlGraphTool,
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
    raw_orders: { name: "RAW_ORDERS_T", type: "table", columns: [{ name: "id" }, { name: "amount" }] },
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
    { uniqueId: "source.shop.raw.raw_orders", sourceTable: "RAW_ORDERS_T", resourceType: "source" },
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
    expect(graph.nodes.map((n) => n.id)).toEqual(["raw_orders", "o", "stg_customers", "orders"])
    expect(JSON.stringify(graph)).not.toContain("__final_select__")
  })

  test("ties table nodes to dbt unique ids, case-insensitively, and the model to itself", () => {
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]))
    expect(byId.raw_orders).toEqual({
      id: "raw_orders",
      name: "RAW_ORDERS_T",
      type: "source",
      nodeId: "source.shop.raw.raw_orders",
      sql: "",
      columns: [{ name: "id" }, { name: "amount" }],
    })
    expect(byId.stg_customers).toEqual({
      id: "stg_customers",
      name: "stg_customers",
      type: "model",
      nodeId: "model.shop.stg_customers",
      sql: "",
      columns: [{ name: "id" }, { name: "name" }],
    })
    expect(byId.orders).toEqual({
      id: "orders",
      name: "orders",
      type: "model",
      nodeId: "model.shop.orders",
      sql: "select * from o",
      columns: [{ name: "id" }],
    })
  })

  test("leaves CTEs unmapped and drops the layout positions", () => {
    const cte = graph.nodes.find((n) => n.id === "o")!
    expect(cte).toEqual({ id: "o", name: "o", type: "cte", sql: "select * from raw.orders", columns: [{ name: "id" }] })
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
      { id: "stg_customers", name: "stg_customers", type: "table", sql: "", columns: [] },
      { id: "orders", name: "orders", type: "cte", sql: "select * from stg_customers", columns: [{ name: "id" }] },
      {
        id: "orders (final select)",
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
    expect(graph.nodes.find((n) => n.id === "raw_orders")?.nodeId).toBe("source.shop.raw.raw_orders")
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
    expect(text).toContain("- o (cte): 1 columns, from RAW_ORDERS_T")
  })
})

describe("the backend's real node shapes", () => {
  // Relations are keyed by location and a per-occurrence suffix, and carry `name`, `db` and `schema`; joins, filters and the like have no name and carry
  // `expression` instead of `sql`.
  const real: SqlLineageResponse = {
    tableEdges: [
      ["analytics.customers_111", "LEFT_JOIN_9"],
      ["raw.customers_222", "LEFT_JOIN_9"],
      ["LEFT_JOIN_9", "__final_select__"],
      ["analytics.customers_111", "WHERE_7"],
      ["WHERE_7", "__final_select__"],
    ],
    details: {
      "analytics.customers_111": {
        name: "customers",
        type: "table",
        expression: "analytics.customers",
        db: "db",
        schema: "analytics",
        columns: [],
      },
      "raw.customers_222": {
        name: "customers",
        type: "table",
        expression: "raw.customers",
        db: "db",
        schema: "raw",
        columns: [],
      },
      LEFT_JOIN_9: { type: "LEFT_JOIN", expression: "LEFT JOIN raw.customers ON 1 = 1", columns: [] },
      WHERE_7: { type: "FILTER", expression: "WHERE amount > 0" },
      __final_select__: { name: "__final_select__", type: "final", sql: "select 1", columns: [{ name: "id" }] },
    },
  }
  const graph = remapSqlLineage(real, { name: "orders", uniqueId: "model.shop.orders", resourceType: "model" }, [
    { uniqueId: "model.shop.customers", alias: "customers", schema: "analytics", resourceType: "model" },
    { uniqueId: "source.shop.raw.customers", sourceTable: "customers", schema: "raw", resourceType: "source" },
  ])

  test("every edge ends at a node id, though two relations share a name", () => {
    const ids = graph.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const edge of graph.edges) for (const end of edge) expect(ids).toContain(end)
    expect(graph.nodes.filter((n) => n.name === "customers")).toHaveLength(2)
  })

  test("a relation is tied to the dbt node in its own schema, and a join or filter keeps its SQL", () => {
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]))
    expect(byId["analytics.customers_111"]).toMatchObject({
      nodeId: "model.shop.customers",
      type: "model",
      sql: "analytics.customers",
    })
    expect(byId["raw.customers_222"]).toMatchObject({ nodeId: "source.shop.raw.customers", type: "source" })
    expect(byId.LEFT_JOIN_9).toEqual({
      id: "LEFT_JOIN_9",
      name: "LEFT_JOIN_9",
      type: "LEFT_JOIN",
      sql: "LEFT JOIN raw.customers ON 1 = 1",
      columns: [],
    })
    expect(byId.WHERE_7.sql).toBe("WHERE amount > 0")
  })

  test("two relations of one name and schema in different databases are told apart by the database", () => {
    const twoDbs: SqlLineageResponse = {
      tableEdges: [],
      details: {
        "a.raw.customers_1": { name: "customers", type: "table", db: "a", schema: "raw" },
        "b.raw.customers_2": { name: "customers", type: "table", db: "b", schema: "raw" },
      },
    }
    const parentsIn = (first: string, second: string) => [
      {
        uniqueId: `source.p.${first}.customers`,
        sourceTable: "customers",
        schema: "raw",
        database: first,
        resourceType: "source",
      },
      {
        uniqueId: `source.p.${second}.customers`,
        sourceTable: "customers",
        schema: "raw",
        database: second,
        resourceType: "source",
      },
    ]
    const model = { name: "orders", uniqueId: "model.shop.orders", resourceType: "model" }
    for (const order of [parentsIn("a", "b"), parentsIn("b", "a")]) {
      const out = remapSqlLineage(twoDbs, model, order)
      expect(out.nodes.map((n) => n.nodeId)).toEqual(["source.p.a.customers", "source.p.b.customers"])
    }
  })

  test("a relation two parents could both be is tied to neither, whatever the parent order", () => {
    const ambiguous: SqlLineageResponse = {
      tableEdges: [],
      details: { "raw.customers_1": { name: "customers", type: "table", schema: "raw" } },
    }
    const model = { name: "orders", uniqueId: "model.shop.orders", resourceType: "model" }
    const a = { uniqueId: "source.p.raw.customers", sourceTable: "customers", schema: "raw", resourceType: "source" }
    const b = { uniqueId: "model.p.customers", alias: "customers", schema: "raw", resourceType: "model" }
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const out = remapSqlLineage(ambiguous, model, order)
      expect(out.nodes).toEqual([{ id: "raw.customers_1", name: "customers", type: "table", sql: "", columns: [] }])
    }
  })

  test("every occurrence of one relation in the SQL is tied to its dbt node", () => {
    const twice: SqlLineageResponse = {
      tableEdges: [],
      details: {
        "analytics.customers_1": { name: "customers", type: "table", schema: "analytics" },
        "analytics.customers_2": { name: "customers", type: "table", schema: "analytics" },
      },
    }
    const out = remapSqlLineage(twice, { name: "orders", uniqueId: "model.shop.orders", resourceType: "model" }, [
      { uniqueId: "model.shop.customers", alias: "customers", schema: "analytics", resourceType: "model" },
    ])
    expect(out.nodes.map((n) => n.nodeId)).toEqual(["model.shop.customers", "model.shop.customers"])
  })
})

describe("a cancel while the backend is answering", () => {
  test("ends the call at once, and a late answer is ignored", async () => {
    const controller = new AbortController()
    let release!: (r: SqlLineageResponse) => void
    const slow = new Promise<SqlLineageResponse>((resolve) => (release = resolve))
    const call = buildSqlGraph(
      adapter(),
      "orders",
      { fetchLineage: () => slow, readFile: (f) => f, projectRoot: "/proj", sessionId: "ses_1" },
      controller.signal,
    )
    const settled = call.then(
      () => "answered",
      () => "aborted",
    )
    await Bun.sleep(10)
    controller.abort()
    expect(await settled).toBe("aborted")
    release(reply)
  })

  test("a reply with no graph is a clear failure, not a crash", async () => {
    const deps = {
      fetchLineage: async () => ({}) as SqlLineageResponse,
      readFile: (f: string) => f,
      projectRoot: "/proj",
      sessionId: "ses_1",
    }
    await expect(buildSqlGraph(adapter(), "orders", deps, signal)).rejects.toThrow("the backend returned no SQL graph")
  })
})

describe("the tool's own answer", () => {
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_sql_graph"),
    messageID: MessageID.make("msg_sql_graph"),
    agent: "analyst",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }

  afterEach(() => {
    resetDbtAdapter()
    delete dbtAdapterInternals.readConfig
    delete dbtAdapterInternals.create
  })

  test("a read-only call is a failure the CLI reports as one: success false and an error", async () => {
    const tool = await initTool(DbtSqlGraphTool as any)
    const result = await tool.execute({ model: "orders" }, { ...ctx, extra: { forceReadOnly: true } })
    expect(result.metadata).toEqual({
      success: false,
      model: "orders",
      reason: expect.stringContaining("--allow-write"),
      error: expect.stringContaining("--allow-write"),
      truncated: false,
    })
    expect(result.output).toContain("Not available")
  })

  test("a model the manifest lacks is a failure with the reason", async () => {
    const project = realpathSync(await mkdtemp(path.join(os.tmpdir(), "dbt-sql-graph-")))
    await writeFile(path.join(project, "dbt_project.yml"), "name: shop\n")
    dbtAdapterInternals.readConfig = async () => ({
      projectRoot: project,
      pythonPath: "python3",
      dbtIntegration: "corecommand",
      queryLimit: 500,
    })
    dbtAdapterInternals.create = async () => ({
      isInitialized: () => true,
      dispose: async () => {},
      parseManifest: async () => ({
        nodeMetaMap: { lookupByUniqueId: () => undefined, lookupByBaseName: () => undefined },
        sourceMetaMap: { get: () => undefined },
      }),
    })
    const tool = await initTool(DbtSqlGraphTool as any)
    const result = await tool
      .execute({ model: "nope" }, ctx)
      .finally(() => rm(project, { recursive: true, force: true }))
    expect(result.metadata).toMatchObject({
      success: false,
      model: "nope",
      error: "no model named nope in the manifest",
    })
  })
})
