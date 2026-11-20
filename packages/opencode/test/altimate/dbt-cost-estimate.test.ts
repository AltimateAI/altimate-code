// dbt_cost_estimate: the dry run's formatted size read back into bytes (and its upper bound) for each unit,
// the answer for a warehouse with no dry run, a read-only call, and a model compiled by name. The dbt adapter is
// replaced through `dbtAdapterInternals`, so these tests need no Python, dbt or warehouse.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { dbtAdapterInternals, resetDbtAdapter } from "@/altimate/native/connections/register"
import {
  DbtCostEstimateTool,
  dbtCostEstimateInternals,
  explainJinja,
  firstStatement,
  mayBeScript,
  parseBytesProcessed,
  readsFiles,
  scanSql,
  parseDatabricksExplainCost,
  parseSnowflakeExplain,
  untilAbort,
} from "@/altimate/tools/dbt-cost-estimate"
import { initTool } from "./tool-fixture"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_dbt_cost_estimate"),
  messageID: MessageID.make("msg_dbt_cost_estimate"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

let project: string

type Calls = { nodes: string[]; queries: [string, string | undefined][]; dryRuns: string[] }

function fakeAdapter(
  calls: Calls,
  opts: {
    type?: string
    bytes?: unknown
    compileFails?: boolean
    dryRunFails?: boolean
    compile?: () => Promise<string>
    /** What compiling the EXPLAIN Jinja renders (the plan's first column as JSON), or a failure to throw. */
    explain?: () => Promise<string>
  } = {},
) {
  return {
    isInitialized: () => true,
    dispose: async () => {},
    getAdapterType: () => opts.type ?? "bigquery",
    unsafeCompileNode: async (model: string) => {
      calls.nodes.push(model)
      if (opts.compile) return opts.compile()
      if (opts.compileFails) throw new Error("compilation failed")
      return `compiled(${model})`
    },
    unsafeCompileQuery: async (query: string, name?: string) => {
      calls.queries.push([query, name])
      if (opts.explain && query.startsWith("{%- if execute -%}{%- set altimate_plan")) return opts.explain()
      if (opts.compileFails) throw new Error("compilation failed")
      return `compiled(${query})`
    },
    validateSQLDryRun: async (query: string) => {
      calls.dryRuns.push(query)
      if (opts.dryRunFails) throw new Error("Access Denied: BigQuery job")
      return "bytes" in opts && opts.bytes === null ? null : { bytes_processed: "bytes" in opts ? opts.bytes : "4.2 TiB" }
    },
  }
}

function useAdapter(calls: Calls, opts?: Parameters<typeof fakeAdapter>[1]) {
  dbtAdapterInternals.readConfig = async () => ({
    projectRoot: project,
    pythonPath: "python3",
    dbtIntegration: "corecommand",
    queryLimit: 500,
  })
  dbtAdapterInternals.create = async () => fakeAdapter(calls, opts)
}

beforeAll(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "dbt-cost-estimate-"))
  await writeFile(path.join(project, "dbt_project.yml"), "name: shop\n")
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

let calls: Calls
beforeEach(() => {
  resetDbtAdapter()
  calls = { nodes: [], queries: [], dryRuns: [] }
})
afterEach(() => {
  resetDbtAdapter()
  delete dbtAdapterInternals.readConfig
  delete dbtAdapterInternals.create
})

describe("parseBytesProcessed", () => {
  test.each([
    ["0.0 Bytes", 0, 0],
    ["512.0 Bytes", 512, 512],
    ["1.0 KiB", 1024, Math.ceil(1.05 * 1024)],
    ["1.5 KiB", 1536, Math.ceil(1.55 * 1024)],
    ["2.0 MiB", 2 * 1024 ** 2, Math.ceil(2.05 * 1024 ** 2)],
    ["4.2 GiB", Math.round(4.2 * 1024 ** 3), Math.ceil(4.25 * 1024 ** 3)],
    ["4.2 TiB", Math.round(4.2 * 1024 ** 4), Math.ceil(4.25 * 1024 ** 4)],
    ["1.0 PiB", 1024 ** 5, Math.ceil(1.05 * 1024 ** 5)],
    ["10.5 PiB", Math.round(10.5 * 1024 ** 5), Math.ceil(10.55 * 1024 ** 5)],
    ["  7.0 MiB ", 7 * 1024 ** 2, Math.ceil(7.05 * 1024 ** 2)],
  ])("reads %s as %d bytes, at most about %d", (display, bytes, maxBytes) => {
    const parsed = parseBytesProcessed(display)!
    expect(parsed.bytes).toBe(bytes)
    // The bound is the figure plus half its last digit; past a PiB it carries a few bytes of float margin.
    expect(parsed.maxBytes).toBeGreaterThanOrEqual(maxBytes)
    expect(parsed.maxBytes).toBeLessThanOrEqual(maxBytes + maxBytes * 1e-14 + 1)
  })

  test("a rounded figure's upper bound covers a scan just over a limit", () => {
    // 10 GiB + 20 MiB is shown as "10.0 GiB": the point estimate sits on the limit, the bound above it.
    const over = 10 * 1024 ** 3 + 20 * 1024 ** 2
    const parsed = parseBytesProcessed("10.0 GiB")!
    expect(parsed.bytes).toBe(10 * 1024 ** 3)
    expect(parsed.maxBytes).toBeGreaterThanOrEqual(over)
  })

  test("the upper bound reaches a count just past a tie that the dry run shows rounded down", () => {
    // 9.25 PiB is a tie in the dry run's float formatting, which shows it as "9.2": the bound sits above the tie.
    const tie = 37n * 1024n ** 5n / 4n
    expect(BigInt(parseBytesProcessed("9.2 PiB")!.maxBytes)).toBeGreaterThan(tie)
  })

  test("takes a number as the exact count", () => {
    expect(parseBytesProcessed(2048)).toEqual({ bytes: 2048, maxBytes: 2048 })
  })

  test.each([["4.2 EiB"], ["4.2"], ["TiB"], [""], ["about 4 GiB"], ["-1.0 KiB"], [null], [undefined], [{}], [Number.NaN], [-5]])(
    "does not read %p",
    (value) => {
      expect(parseBytesProcessed(value)).toBeUndefined()
    },
  )
})

describe("dbt_cost_estimate", () => {
  test("estimates a model compiled by name", async () => {
    useAdapter(calls)
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(calls).toEqual({ nodes: ["orders"], queries: [], dryRuns: ["compiled(orders)"] })
    expect(result.metadata).toEqual({
      success: true,
      supported: true,
      adapter: "bigquery",
      bytes: Math.round(4.2 * 1024 ** 4),
      maxBytes: Math.ceil(4.25 * 1024 ** 4),
      display: "4.2 TiB",
      model: "orders",
      truncated: false,
    })
    expect(result.output).toContain("orders would process 4.2 TiB")
  })

  test("estimates SQL as given", async () => {
    useAdapter(calls, { bytes: "1.0 GiB" })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select 1" }, ctx)
    expect(calls).toEqual({ nodes: [], queries: [["select 1", undefined]], dryRuns: ["compiled(select 1)"] })
    expect(result.metadata).toEqual({
      success: true,
      supported: true,
      adapter: "bigquery",
      bytes: 1024 ** 3,
      maxBytes: Math.ceil(1.05 * 1024 ** 3),
      display: "1.0 GiB",
      truncated: false,
    })
  })

  test("a number from the dry run is shown with its unit and is exact", async () => {
    useAdapter(calls, { bytes: 2048 })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select 1" }, ctx)
    expect(result.metadata).toMatchObject({ bytes: 2048, maxBytes: 2048, display: "2048 Bytes" })
    expect(result.output).toContain("2048 Bytes")
  })

  test("a zero from the dry run is a lower bound, not an upper bound", async () => {
    useAdapter(calls, { bytes: 0 })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select 1" }, ctx)
    expect(result.metadata).toEqual({
      success: true,
      supported: true,
      adapter: "bigquery",
      bytes: 0,
      lowerBound: true,
      display: "0 Bytes",
      truncated: false,
    })
    expect(result.output).toContain("lower bound")
    expect(result.output).not.toContain("at most")
  })

  test.each([
    "select 1; select * from big",
    "select 1; execute immediate 'select * from big'",
    "execute immediate 'select * from big'",
    "select * from t where m = '--'; execute immediate 'select * from big'",
    "select * from t where m = '#sale'; select * from big",
  ])("a script (%s) is a lower bound, not an upper bound", async (sql) => {
    useAdapter(calls, { bytes: "1.0 GiB" })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql }, ctx)
    expect(result.metadata).toMatchObject({ bytes: 1024 ** 3, lowerBound: true })
    expect(result.metadata).not.toHaveProperty("maxBytes")
    expect(result.output).not.toContain("at most")
  })

  test("a semicolon in a string or a comment is not a script", async () => {
    useAdapter(calls, { bytes: "1.0 GiB" })
    const tool = await initTool(DbtCostEstimateTool)
    for (const sql of ["select 'a;b' from t", "select 1 -- x; y\nfrom t", "select `p.d;t`.c from `p.d.t`"]) {
      const result = await tool.execute({ sql }, ctx)
      expect(result.metadata).toHaveProperty("maxBytes")
    }
  })

  test.each(["duckdb", "redshift", "postgres"])("answers supported:false on %s and compiles nothing", async (type) => {
    useAdapter(calls, { type })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata).toMatchObject({ success: true, supported: false, adapter: type })
    expect(result.metadata.bytes).toBeUndefined()
    expect(result.output).toBe(`No cost estimate: scan estimates are only available on BigQuery, Snowflake and Databricks (this project uses ${type}).`)
    expect(calls).toEqual({ nodes: [], queries: [], dryRuns: [] })
  })

  test("refuses a read-only call and starts no adapter", async () => {
    let created = 0
    useAdapter(calls)
    const make = dbtAdapterInternals.create!
    dbtAdapterInternals.create = async (config) => {
      created += 1
      return make(config)
    }
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, { ...ctx, extra: { forceReadOnly: true } })
    expect(created).toBe(0)
    expect(result.metadata).toMatchObject({ success: false, refusal: "read_only" })
    expect(result.output).toContain("--allow-write")
  })

  test("the tool description says compiling can run billed queries and the adapter start runs dbt deps", async () => {
    const tool = await initTool(DbtCostEstimateTool)
    expect(tool.description).toContain("runs `dbt deps`")
    expect(tool.description).toContain("compiling either input can render Jinja, and macros such as `run_query` can run real queries that are billed")
  })

  test("the tool description names the MCP server as a way to grant write", async () => {
    const tool = await initTool(DbtCostEstimateTool)
    expect(tool.description).toContain("`--allow-write` on `tool run` or the MCP server")
  })

  test("rejects a call that passes both a model and SQL, estimating neither", async () => {
    useAdapter(calls)
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders", sql: "select 1" }, ctx)
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("not both")
    expect(calls).toEqual({ nodes: [], queries: [], dryRuns: [] })
  })

  test("asks for something to estimate", async () => {
    useAdapter(calls)
    const result = await (await initTool(DbtCostEstimateTool)).execute({}, ctx)
    expect(result.metadata.success).toBe(false)
    expect(calls).toEqual({ nodes: [], queries: [], dryRuns: [] })
  })

  test("reports a model dbt can't compile, as a compile failure, without a dry run", async () => {
    useAdapter(calls, { compileFails: true })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "nope" }, ctx)
    expect(result.title).toBe("dbt_cost_estimate: compile failed")
    expect(result.metadata).toMatchObject({ success: false, error: "compilation failed" })
    expect(calls.dryRuns).toEqual([])
  })

  test("reports a compile that produced nothing, without a dry run", async () => {
    useAdapter(calls, { compile: async () => "  " })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata).toMatchObject({ success: false, error: "The query compiled to nothing." })
    expect(calls.dryRuns).toEqual([])
  })

  test("reports a dry run that returns nothing, as dbt-core before 1.6 does", async () => {
    useAdapter(calls, { bytes: null })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select 1" }, ctx)
    expect(result.metadata).toMatchObject({ success: false })
    expect(result.output).toContain("before 1.6")
  })

  test("a cancelled call stops waiting for a compile that never finishes", async () => {
    const abort = new AbortController()
    useAdapter(calls, { compile: () => new Promise<string>(() => {}) })
    const run = (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, { ...ctx, abort: abort.signal })
    await Bun.sleep(20)
    abort.abort(new Error("cancelled"))
    await expect(run).rejects.toThrow("cancelled")
    expect(calls.dryRuns).toEqual([])
  })

  test("work queued before a cancellation is not started by it", async () => {
    // The signal reads as live at the first check and cancelled once the queued work comes to run.
    let reads = 0
    const signal = {
      get aborted() {
        return ++reads > 1
      },
      reason: new Error("cancelled"),
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal
    let started = 0
    await expect(untilAbort(async () => void started++, signal)).rejects.toThrow("cancelled")
    expect(started).toBe(0)
  })

  test("reports a dry run the warehouse refused", async () => {
    useAdapter(calls, { dryRunFails: true })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select 1" }, ctx)
    expect(result.title).toBe("dbt_cost_estimate: dry run failed")
    expect(result.metadata).toMatchObject({ success: false, error: "Access Denied: BigQuery job" })
  })

  test("reports a size it can't read instead of guessing", async () => {
    useAdapter(calls, { bytes: "lots" })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select 1" }, ctx)
    expect(result.metadata.success).toBe(false)
    expect(result.metadata.bytes).toBeUndefined()
    expect(result.output).toContain('"lots"')
  })

  test("escapes quotes and backslashes for the integrations that write the SQL into a Jinja argument", async () => {
    useAdapter(calls)
    await (await initTool(DbtCostEstimateTool)).execute({ sql: "where s = 'a\\b'" }, ctx)
    expect(calls.dryRuns).toEqual(["compiled(where s = \\'a\\\\b\\')"])
  })

  test("hands the SQL to the Python bridge as is", async () => {
    useAdapter(calls)
    dbtAdapterInternals.readConfig = async () => ({ projectRoot: project, pythonPath: "python3", dbtIntegration: "core", queryLimit: 500 })
    await (await initTool(DbtCostEstimateTool)).execute({ sql: "where s = 'a'" }, ctx)
    expect(calls.dryRuns).toEqual(["compiled(where s = 'a')"])
  })

  test("a config that names no integration is the Python bridge: the SQL goes as is", async () => {
    useAdapter(calls)
    dbtAdapterInternals.readConfig = async () => ({ projectRoot: project, pythonPath: "python3", queryLimit: 500 })
    await (await initTool(DbtCostEstimateTool)).execute({ sql: "where s = 'a'" }, ctx)
    expect(calls.dryRuns).toEqual(["compiled(where s = 'a')"])
  })
})

// Snowflake's EXPLAIN USING JSON answers one row, column `content`: the shape documented for the command, with a
// table scan per object read. Databricks' EXPLAIN COST answers one row, column `plan`: Spark's tree string, each node
// suffixed with `Statistics(sizeInBytes=…[, rowCount=…])` as Statistics.simpleString and Utils.bytesToString write it.
const SNOWFLAKE_PLAN = JSON.stringify({
  GlobalStats: { partitionsTotal: 1240, partitionsAssigned: 37, bytesAssigned: 2_147_483_648 },
  Operations: [
    [
      { id: 0, operation: "Result", expressions: ["ORDERS.O_ORDERKEY", "CUSTOMER.C_NAME"] },
      { id: 1, parentOperators: [0], operation: "InnerJoin", expressions: ["joinKey: (CUSTOMER.C_CUSTKEY = ORDERS.O_CUSTKEY)"] },
      {
        id: 2,
        parentOperators: [1],
        operation: "TableScan",
        objects: ["ANALYTICS.PUBLIC.ORDERS"],
        expressions: ["O_ORDERKEY", "O_CUSTKEY", "O_ORDERDATE"],
        partitionsAssigned: 30,
        partitionsTotal: 1200,
        bytesAssigned: 2_000_000_000,
      },
      { id: 3, parentOperators: [1], operation: "JoinFilter", expressions: ["joinKey: (CUSTOMER.C_CUSTKEY = ORDERS.O_CUSTKEY)"] },
      {
        id: 4,
        parentOperators: [3],
        operation: "TableScan",
        objects: ["ANALYTICS.PUBLIC.CUSTOMER"],
        expressions: ["C_CUSTKEY", "C_NAME"],
        partitionsAssigned: 7,
        partitionsTotal: 40,
        bytesAssigned: 147_483_648,
      },
    ],
  ],
})

const DATABRICKS_PLAN = [
  "== Optimized Logical Plan ==",
  "Aggregate [o_custkey#12L], [o_custkey#12L, sum(o_totalprice#15) AS revenue#40], Statistics(sizeInBytes=1.2 MiB, rowCount=5.00E+4)",
  "+- Project [o_custkey#12L, o_totalprice#15], Statistics(sizeInBytes=1.6 GiB)",
  "   +- Join Inner, (o_custkey#12L = c_custkey#30L), Statistics(sizeInBytes=3.0 GiB)",
  "      :- Filter (isnotnull(o_orderdate#16) AND (o_orderdate#16 >= 2024-01-01)), Statistics(sizeInBytes=2.5 GiB)",
  "      :  +- Relation main.sales.orders[o_orderkey#11L,o_custkey#12L,o_totalprice#15,o_orderdate#16] parquet, Statistics(sizeInBytes=2.5 GiB, rowCount=1.50E+7)",
  "      +- Relation main.sales.customer[c_custkey#30L,c_name#31] parquet, Statistics(sizeInBytes=512.0 MiB)",
  "",
  "== Physical Plan ==",
  "AdaptiveSparkPlan isFinalPlan=false",
  "+- HashAggregate(keys=[o_custkey#12L], functions=[sum(o_totalprice#15)])",
  "   +- FileScan parquet main.sales.orders[o_custkey#12L] Batched: true, Statistics(sizeInBytes=99.0 EiB)",
].join("\n")

describe("parseSnowflakeExplain", () => {
  test("reads GlobalStats: the bytes and partitions left after pruning", () => {
    expect(parseSnowflakeExplain(SNOWFLAKE_PLAN)).toEqual({ bytes: 2_147_483_648, partitionsAssigned: 37, partitionsTotal: 1240 })
  })

  test("takes the content already parsed", () => {
    expect(parseSnowflakeExplain(JSON.parse(SNOWFLAKE_PLAN))).toEqual({ bytes: 2_147_483_648, partitionsAssigned: 37, partitionsTotal: 1240 })
  })

  test("a query that reads no table is zero bytes", () => {
    expect(parseSnowflakeExplain('{"GlobalStats":{"partitionsTotal":0,"partitionsAssigned":0,"bytesAssigned":0},"Operations":[[{"id":0,"operation":"Result"}]]}')).toEqual({
      bytes: 0,
      partitionsAssigned: 0,
      partitionsTotal: 0,
    })
  })

  test("bytes without partition counts are still an estimate", () => {
    expect(parseSnowflakeExplain({ GlobalStats: { bytesAssigned: 1024 } })).toEqual({ bytes: 1024 })
  })

  test.each([
    ["not JSON", "GlobalStats: 1024"],
    ["no GlobalStats", '{"Operations":[]}'],
    ["no bytesAssigned", '{"GlobalStats":{"partitionsTotal":3}}'],
    ["text bytes", '{"GlobalStats":{"bytesAssigned":"1024"}}'],
    ["negative bytes", '{"GlobalStats":{"bytesAssigned":-1}}'],
    ["the tabular format", "step\tid\tparent\toperation"],
    ["null", null],
    ["a number", 1024],
  ])("does not read %s", (_, content) => {
    expect(parseSnowflakeExplain(content)).toBeUndefined()
  })
})

describe("parseDatabricksExplainCost", () => {
  test("sums the leaves of the optimized plan: the relations it scans, not the operators above them", () => {
    expect(parseDatabricksExplainCost(DATABRICKS_PLAN)).toEqual({ bytes: Math.round(2.5 * 1024 ** 3 + 512 * 1024 ** 2) })
  })

  test("a single relation and Spark's B unit", () => {
    const plan = "== Optimized Logical Plan ==\nProject [id#0L], Statistics(sizeInBytes=12.0 B)\n+- Relation main.t[id#0L] parquet, Statistics(sizeInBytes=16.0 B, rowCount=2)\n\n== Physical Plan ==\n*(1) ColumnarToRow"
    expect(parseDatabricksExplainCost(plan)).toEqual({ bytes: 16 })
  })

  test("a scalar subquery's plan is printed inside the tree, and its relation counts too", () => {
    const plan = [
      "== Optimized Logical Plan ==",
      "Project [id#1L, scalar-subquery#5 [] AS m#6L], Statistics(sizeInBytes=2.0 MiB)",
      ":  +- Aggregate [max(v#3L) AS max(v)#8L], Statistics(sizeInBytes=16.0 B, rowCount=1)",
      ":     +- Relation main.s.dim[v#3L] parquet, Statistics(sizeInBytes=3.0 MiB)",
      "+- Relation main.s.fact[id#1L] parquet, Statistics(sizeInBytes=1.5 GiB)",
      "",
      "== Physical Plan ==",
    ].join("\n")
    expect(parseDatabricksExplainCost(plan)).toEqual({ bytes: Math.round(1.5 * 1024 ** 3 + 3 * 1024 ** 2) })
  })

  test("reads Spark 2's KB/MB units and the scientific form past a long", () => {
    expect(parseDatabricksExplainCost("== Optimized Logical Plan ==\nRelation[a#0] parquet, Statistics(sizeInBytes=2.0 MB, hints=none)")).toEqual({
      bytes: 2 * 1024 ** 2 ,
    })
    // A size past 2^62 is Spark's "no statistics" default or larger: not a size.
    expect(parseDatabricksExplainCost("== Optimized Logical Plan ==\nRelation[a#0] parquet, Statistics(sizeInBytes=1.23E+21 B)")).toEqual({ noStats: true })
  })

  test("a relation without statistics shows Spark's default size, Long.MaxValue: no estimate, not 8 EiB", () => {
    const plan = "== Optimized Logical Plan ==\nJoin Inner, Statistics(sizeInBytes=8.0 EiB)\n:- Relation main.a[x#1] parquet, Statistics(sizeInBytes=1.0 GiB)\n+- Relation jdbc.b[x#2] JDBCRelation, Statistics(sizeInBytes=8.0 EiB)"
    expect(parseDatabricksExplainCost(plan)).toEqual({ noStats: true, relation: "jdbc.b" })
  })

  test("a leaf with no statistics at all is no estimate", () => {
    expect(parseDatabricksExplainCost("== Optimized Logical Plan ==\nProject [a#0], Statistics(sizeInBytes=1.0 KiB)\n+- Relation main.t[a#0] parquet")).toEqual({ noStats: true, relation: "main.t", unread: true })
  })

  test.each([
    ["no optimized plan section", "== Physical Plan ==\n*(1) Scan"],
    ["an empty section", "== Optimized Logical Plan ==\n\n== Physical Plan ==\nScan"],
    ["not text", { plan: "x" }],
    ["null", null],
  ])("does not read %s", (_, plan) => {
    expect(parseDatabricksExplainCost(plan)).toBeUndefined()
  })

  test("reads Windows line endings", () => {
    expect(parseDatabricksExplainCost("== Optimized Logical Plan ==\r\nRelation main.t[a#0] parquet, Statistics(sizeInBytes=4.0 KiB)\r\n")).toEqual({ bytes: 4096 })
  })
})

describe("explainJinja", () => {
  test("runs the EXPLAIN through dbt's run_query and renders its first column as JSON", () => {
    expect(explainJinja("EXPLAIN COST", "select 1")).toBe(
      "{%- if execute -%}{%- set altimate_plan = run_query('EXPLAIN COST\nselect 1') -%}{{ tojson(altimate_plan.columns[0].values() | list) }}{%- else -%}[]{%- endif -%}",
    )
  })

  test("at dbt's parse pass (execute false) it runs nothing and renders an empty list, not an error", () => {
    // dbt compile --inline renders the query at parse first, where run_query returns None: reading its columns there failed.
    const template = explainJinja("EXPLAIN USING JSON", "select 1")
    const parsePass = /^\{%- if execute -%\}[\s\S]*\{%- else -%\}([\s\S]*)\{%- endif -%\}$/.exec(template)
    expect(parsePass?.[1]).toBe("[]")
    expect(template.indexOf("run_query")).toBeLessThan(template.indexOf("{%- else -%}"))
  })

  test("escapes quotes and backslashes for the Jinja string, and drops a trailing semicolon", () => {
    expect(explainJinja("EXPLAIN USING JSON", "select * from t where s = 'a\\b';\n")).toContain("run_query('EXPLAIN USING JSON\nselect * from t where s = \\'a\\\\b\\'')")
  })
})

describe("dbt_cost_estimate on a warehouse with a planner", () => {
  const rendered = (row: unknown) => async () => JSON.stringify([row])

  test("Snowflake: compiles the model, then EXPLAINs it, and answers the bytes assigned as an upper bound", async () => {
    useAdapter(calls, { type: "snowflake", explain: rendered(SNOWFLAKE_PLAN) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(calls.nodes).toEqual(["orders"])
    expect(calls.queries).toEqual([[explainJinja("EXPLAIN USING JSON", "compiled(orders)"), undefined]])
    expect(calls.dryRuns).toEqual([])
    expect(result.metadata).toEqual({
      success: true,
      supported: true,
      adapter: "snowflake",
      source: "explain",
      bound: "upper",
      bytes: 2_147_483_648,
      display: "2.0 GiB",
      partitionsAssigned: 37,
      partitionsTotal: 1240,
      model: "orders",
      truncated: false,
    })
    expect(result.output).toContain("orders would scan about 2.0 GiB, by Snowflake's plan estimate (37 of 1240 partitions after pruning; an upper bound")
  })

  test("Databricks: estimates inline SQL from EXPLAIN COST, as an estimate, not a bound", async () => {
    useAdapter(calls, { type: "databricks", explain: rendered(DATABRICKS_PLAN) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select * from {{ ref('orders') }}" }, ctx)
    expect(calls.queries).toEqual([
      ["select * from {{ ref('orders') }}", undefined],
      [explainJinja("EXPLAIN COST", "compiled(select * from {{ ref('orders') }})"), undefined],
    ])
    expect(result.metadata).toEqual({
      success: true,
      supported: true,
      adapter: "databricks",
      source: "explain",
      bound: "estimate",
      bytes: Math.round(2.5 * 1024 ** 3 + 512 * 1024 ** 2),
      display: "3.0 GiB",
      truncated: false,
    })
    expect(result.output).toContain("not a bound either way")
  })

  test("Databricks without table statistics: no estimate, and says why", async () => {
    useAdapter(calls, { type: "databricks", explain: rendered("== Optimized Logical Plan ==\nRelation x.y[a#1] parquet, Statistics(sizeInBytes=8.0 EiB)") })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata).toEqual({ success: false, adapter: "databricks", source: "explain", error: expect.stringContaining("no size for x.y"), truncated: false })
    expect(result.metadata.bytes).toBeUndefined()
    expect(result.output).toContain("ANALYZE TABLE x.y COMPUTE STATISTICS NOSCAN")
    expect(result.output).toContain("no size for x.y")
  })

  test("an EXPLAIN the warehouse refuses is no estimate, with the warehouse's error", async () => {
    useAdapter(calls, { type: "snowflake", explain: async () => Promise.reject(new Error("SQL compilation error: Object 'ORDERS' does not exist")) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.title).toBe("dbt_cost_estimate: explain failed")
    expect(result.metadata).toMatchObject({ success: false, adapter: "snowflake", source: "explain" })
    expect(result.output).toContain("does not exist")
  })

  test.each([
    ["a plan it can't read", JSON.stringify(['{"Operations":[]}'])],
    ["no rows", "[]"],
    ["text that is not JSON", "EXPLAIN output"],
  ])("%s is no estimate, never a count", async (_, out) => {
    useAdapter(calls, { type: "snowflake", explain: async () => out })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata.success).toBe(false)
    expect(result.metadata.bytes).toBeUndefined()
  })

  test("a model that doesn't compile is not EXPLAINed", async () => {
    useAdapter(calls, { type: "snowflake", compileFails: true, explain: rendered(SNOWFLAKE_PLAN) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "nope" }, ctx)
    expect(result.title).toBe("dbt_cost_estimate: compile failed")
    expect(calls.queries).toEqual([])
  })

  test("a cancelled call stops waiting for the EXPLAIN", async () => {
    const abort = new AbortController()
    let started!: () => void
    const explaining = new Promise<void>((resolve) => (started = resolve))
    useAdapter(calls, {
      type: "databricks",
      explain: () => {
        started()
        return new Promise<string>(() => {})
      },
    })
    const run = (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, { ...ctx, abort: abort.signal })
    // Cancelled once the EXPLAIN is under way, not before it starts.
    await explaining
    abort.abort(new Error("cancelled"))
    await expect(run).rejects.toThrow("cancelled")
  })
})

describe("follow-ups to the planner estimate", () => {
  const rendered = (row: unknown) => async () => JSON.stringify([row])
  const originalTimeout = dbtCostEstimateInternals.explainTimeoutMs
  afterEach(() => {
    dbtCostEstimateInternals.explainTimeoutMs = originalTimeout
  })

  test("an EXPLAIN that outlasts its deadline is no estimate, and the call stops waiting", async () => {
    dbtCostEstimateInternals.explainTimeoutMs = 50
    useAdapter(calls, { type: "databricks", explain: () => new Promise<string>(() => {}) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.title).toBe("dbt_cost_estimate: explain failed")
    expect(result.output).toContain("did not answer within 0.05 s")
    expect(result.metadata.bytes).toBeUndefined()
  })

  test("an EXPLAIN that answers within its deadline is read as before", async () => {
    dbtCostEstimateInternals.explainTimeoutMs = 5_000
    useAdapter(calls, { type: "snowflake", explain: rendered(SNOWFLAKE_PLAN) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata.bytes).toBe(2_147_483_648)
  })

  test.each([
    ["a multi-line block comment", "select 1; /* a\nb */", "select 1"],
    ["a second semicolon and a comment", "select 1;; -- c", "select 1"],
    ["a comment on the next line", "select 1;\n-- done\n", "select 1"],
  ])("Snowflake sends %s after the final semicolon to nobody", async (_, compiled, sent) => {
    expect(mayBeScript(compiled, "snowflake")).toBe(false)
    useAdapter(calls, { type: "snowflake", compile: async () => compiled, explain: rendered(SNOWFLAKE_PLAN) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(calls.queries).toEqual([[explainJinja("EXPLAIN USING JSON", sent), undefined]])
    expect(result.metadata.success).toBe(true)
  })

  test.each([
    ["select 'a;b' from t; -- c", "snowflake", "select 'a;b' from t"],
    ["select \"a;b\" /* ; */ from t", "snowflake", 'select "a;b" /* ; */ from t'],
    ["select `a;b` from t; /* x */", "databricks", "select `a;b` from t"],
    ["select 1 -- not; a split", "snowflake", "select 1 -- not; a split"],
    ["select 1", "snowflake", "select 1"],
  ])("firstStatement(%p, %s) keeps what the driver sends as the statement", (sql, type, expected) => {
    expect(firstStatement(sql, type)).toBe(expected)
  })

  test("a section heading inside a multi-line literal does not end the plan", () => {
    const plan = [
      "== Optimized Logical Plan ==",
      "Project [concat(w#1, ",
      "== Physical Plan ==",
      ") AS z#2], Statistics(sizeInBytes=1.0 KiB)",
      "+- Relation spark_catalog.default.b[w#1] parquet, Statistics(sizeInBytes=2.0 GiB)",
      "",
      "== Physical Plan ==",
      "*(1) Project",
    ].join("\n")
    expect(parseDatabricksExplainCost(plan)).toEqual({ bytes: 2 * 1024 ** 3 })
  })

  test("a section heading after a finished node still ends the plan", () => {
    const plan = "== Optimized Logical Plan ==\nRelation main.t[a#0] parquet, Statistics(sizeInBytes=4.0 KiB)\n\n== Physical Plan ==\nRelation main.u[a#0] parquet, Statistics(sizeInBytes=9.0 GiB)"
    expect(parseDatabricksExplainCost(plan)).toEqual({ bytes: 4096 })
  })

  test("brackets inside a printed name do not stretch a node over the plan's real end", () => {
    const plan = "== Optimized Logical Plan ==\nRelation main.t[a(b#0] parquet, Statistics(sizeInBytes=2.0 GiB)\n\n== Physical Plan ==\nFileScan parquet main.t[a(b#0]"
    expect(parseDatabricksExplainCost(plan)).toEqual({ bytes: 2 * 1024 ** 3 })
  })

  test("Snowflake: a scan of an external table or stage, or a scan with no size, keeps the total from being a cap", () => {
    const mixed = (extra: object) =>
      JSON.stringify({
        GlobalStats: { bytesAssigned: 1024 },
        Operations: [[{ id: 1, operation: "TableScan", objects: ["T"], bytesAssigned: 1024 }, { id: 2, ...extra }]],
      })
    expect(parseSnowflakeExplain(mixed({ operation: "ExternalScan", bytesAssigned: 0 }))).toEqual({ bytes: 1024, unsized: true })
    expect(parseSnowflakeExplain(mixed({ operation: "StageScan" }))).toEqual({ bytes: 1024, unsized: true })
    expect(parseSnowflakeExplain(mixed({ operation: "TableScan", objects: ["U"], bytesAssigned: 0 }))).toEqual({ bytes: 1024, unsized: true })
    expect(parseSnowflakeExplain(mixed({ operation: "SecureView", objects: ["V"] }))).toEqual({ bytes: 1024, unsized: true })
    expect(parseSnowflakeExplain(mixed({ operation: "DynamicSecureView" }))).toEqual({ bytes: 1024, unsized: true })
    // A secure view hides what it scans, so a total of 0 beside one is not a cap either.
    expect(parseSnowflakeExplain('{"GlobalStats":{"bytesAssigned":0},"Operations":[[{"id":1,"operation":"SecureView"}]]}')).toEqual({ bytes: 0, unsized: true })
    expect(parseSnowflakeExplain(mixed({ operation: "TableScan", objects: ["U"] }))).toEqual({ bytes: 1024, unsized: true })
    expect(parseSnowflakeExplain(mixed({ operation: "Filter" }))).toEqual({ bytes: 1024 })
    expect(parseSnowflakeExplain(SNOWFLAKE_PLAN)).toEqual({ bytes: 2_147_483_648, partitionsAssigned: 37, partitionsTotal: 1240 })
  })

  test("Snowflake: a positive total beside an external scan is not called an upper bound", async () => {
    const plan = JSON.stringify({
      GlobalStats: { partitionsTotal: 2, partitionsAssigned: 2, bytesAssigned: 1024 },
      Operations: [[{ id: 1, operation: "TableScan", objects: ["T"], bytesAssigned: 1024 }, { id: 2, operation: "ExternalScan", objects: ["E"] }]],
    })
    useAdapter(calls, { type: "snowflake", explain: rendered(plan) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select * from t join e" }, ctx)
    expect(result.metadata).toMatchObject({ success: true, bound: "unknown", bytes: 1024 })
    expect(result.output).not.toContain("an upper bound")
  })

  test("a leaf that holds an inner plan keeps its own size", () => {
    const plan = [
      "== Optimized Logical Plan ==",
      "Relation main.s.t[a#0] parquet, Statistics(sizeInBytes=2.0 GiB)",
      ":  +- Relation main.s.u[a#1] parquet, Statistics(sizeInBytes=3.0 GiB)",
    ].join("\n")
    expect(parseDatabricksExplainCost(plan)).toEqual({ bytes: 5 * 1024 ** 3 })
  })

  test("a leaf with an inner plan but no size of its own is no estimate, not the inner plan's size", () => {
    const plan = [
      "== Optimized Logical Plan ==",
      "Relation main.s.t[a#0] parquet",
      ":  +- Relation main.s.u[a#1] parquet, Statistics(sizeInBytes=3.0 GiB)",
    ].join("\n")
    expect(parseDatabricksExplainCost(plan)).toEqual({ noStats: true, relation: "main.s.t", unread: true })
  })

  test("an EXPLAIN that rejects after its deadline changes nothing", async () => {
    dbtCostEstimateInternals.explainTimeoutMs = 30
    let reject!: (e: Error) => void
    useAdapter(calls, { type: "snowflake", explain: () => new Promise<string>((_, r) => (reject = r)) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.title).toBe("dbt_cost_estimate: explain failed")
    reject(new Error("late"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("did not answer within 0.03 s")
    expect(result.output).not.toContain("late")
  })

  test("a node with a child and an inner plan is still not a leaf", () => {
    const plan = [
      "== Optimized Logical Plan ==",
      "Filter (a#0 IN (list#5 [])), Statistics(sizeInBytes=1.0 GiB)",
      ":  +- Relation main.s.u[a#1] parquet, Statistics(sizeInBytes=3.0 GiB)",
      "+- Relation main.s.t[a#0] parquet, Statistics(sizeInBytes=2.0 GiB)",
    ].join("\n")
    expect(parseDatabricksExplainCost(plan)).toEqual({ bytes: 5 * 1024 ** 3 })
  })

  test("Snowflake's 0 bytes is not called an upper bound: it also reports 0 for a source it cannot size", async () => {
    useAdapter(calls, { type: "snowflake", explain: rendered('{"GlobalStats":{"partitionsTotal":0,"partitionsAssigned":0,"bytesAssigned":0}}') })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select $1 from @stage" }, ctx)
    expect(result.metadata).toMatchObject({ success: true, bound: "unknown", bytes: 0 })
    expect(result.output).toContain("not a cap")
    expect(result.output).not.toContain("an upper bound")
  })

  test("a leaf with no readable size gets no ANALYZE advice: it is not known to lack statistics", async () => {
    useAdapter(calls, { type: "databricks", explain: rendered("== Optimized Logical Plan ==\nRelation main.t[a#0] parquet") })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("printed no size this tool can read for main.t")
    expect(result.output).not.toContain("ANALYZE")
  })
})

describe("mayBeScript", () => {
  test.each([
    ["snowflake", "select 1; delete from orders"],
    ["snowflake", "select 1;\ndelete from orders;"],
    ["snowflake", "select * from t where s = 'a'; drop table t"],
    ["snowflake", "select $$a$$; delete from t"],
    // Snowflake's own comment and dollar-quoted text are not set aside: a doubt counts as a script.
    ["snowflake", "select 1 // note; delete from t"],
    ["snowflake", "select $$a;b$$"],
    ["snowflake", "execute immediate 'select 1'"],
    ["snowflake", "select `a; b` from t"],
    ["snowflake", "select 'unclosed; delete from t"],
    ["databricks", "select 1; delete from orders"],
    ["databricks", "select 1 # c; delete from t"],
    // Found in review: text the scan does not model must not hide a separator the driver sees.
    ["snowflake", "select $$--$$; delete from orders"],
    ["snowflake", "select $$'$$; delete from orders -- '"],
    ["snowflake", "select 1 // '\n; delete from orders -- '"],
    ["snowflake", 'select "a\\" x" ; delete from orders; "'],
    ["snowflake", "select 1 /* unclosed ; delete from orders"],
    ["databricks", "select r'\\'; delete from orders -- '"],
    ["databricks", "select 1 /* a /* b */ ; delete from orders */"],
    ["snowflake", "select 1; -- one\ndelete from orders"],
  ])("on %s, %p may be more than one statement", (type, sql) => {
    expect(mayBeScript(sql, type)).toBe(true)
  })

  test.each([
    ["snowflake", "select 1"],
    ["snowflake", "select 1;\n  "],
    ["snowflake", "select 'a;b', \"x;y\" from t -- one; two\n/* three; */"],
    ["snowflake", "select 'it''s; fine', 'a\\'; b' from t"],
    ["databricks", "select `p;q`.c from t where s = 'a;b'"],
    ["databricks", "with x as (select 1) select * from x;"],
    ["snowflake", "select 1; -- done"],
    ["snowflake", "select 'a\\'; b', \"c\\\"; d\" from t"],
    ["databricks", "select array_join(arr, ';') from t -- x; y"],
  ])("on %s, %p is one statement", (type, sql) => {
    expect(mayBeScript(sql, type)).toBe(false)
  })
})

describe("dbt_cost_estimate refuses to EXPLAIN a script", () => {
  for (const type of ["snowflake", "databricks"]) {
    test(`on ${type}, a second statement is never sent: no estimate, and only the compile ran`, async () => {
      useAdapter(calls, { type, explain: async () => JSON.stringify([SNOWFLAKE_PLAN]) })
      const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select 1; delete from orders" }, ctx)
      expect(calls.queries).toEqual([["select 1; delete from orders", undefined]])
      expect(result.metadata).toMatchObject({ success: false, adapter: type, source: "explain" })
      expect(result.metadata.bytes).toBeUndefined()
      expect(result.output).toContain("more than one statement")
    })
  }
})

describe("parseDatabricksExplainCost reads only the statistics Spark appends", () => {
  test("a column named like statistics is not a size", () => {
    expect(parseDatabricksExplainCost("== Optimized Logical Plan ==\nRelation main.t[Statistics(sizeInBytes=0.0 B)#0] parquet, Statistics(sizeInBytes=1.0 GiB)")).toEqual({
      bytes: 1024 ** 3 ,
    })
  })

  test("nor stands in for missing statistics, or for Spark's default size", () => {
    expect(parseDatabricksExplainCost("== Optimized Logical Plan ==\nRelation main.t[Statistics(sizeInBytes=0.0 B)#0] parquet")).toEqual({ noStats: true, relation: "main.t", unread: true })
    expect(parseDatabricksExplainCost("== Optimized Logical Plan ==\nRelation [Statistics(sizeInBytes=0 B)#0] parquet, Statistics(sizeInBytes=8.0 EiB)")).toEqual({ noStats: true })
  })
})

describe("review follow-ups", () => {
  test("a lone carriage return, which Jinja turns into a line break, cannot end a comment the check reads as running on", async () => {
    for (const type of ["snowflake", "databricks"]) {
      expect(mayBeScript("select 1 -- c\n; delete from orders", type)).toBe(true)
      const local: Calls = { nodes: [], queries: [], dryRuns: [] }
      useAdapter(local, { type, compile: async () => "select 1 -- comment\r; delete from orders", explain: async () => JSON.stringify([SNOWFLAKE_PLAN]) })
      const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
      expect(local.queries).toEqual([])
      expect(result.metadata).toMatchObject({ success: false, source: "explain" })
      expect(result.output).toContain("more than one statement")
    }
  })

  test("the SQL sent is the one checked: line endings are already line breaks", async () => {
    useAdapter(calls, { type: "snowflake", compile: async () => "select 1\r\nfrom t\rwhere x", explain: async () => JSON.stringify([SNOWFLAKE_PLAN]) })
    await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(calls.queries).toEqual([[explainJinja("EXPLAIN USING JSON", "select 1\nfrom t\nwhere x"), undefined]])
  })

  test("only Spark's own section headers end the optimized plan", () => {
    const plan = [
      "== Optimized Logical Plan ==",
      "Union, Statistics(sizeInBytes=2.0 GiB)",
      ":- Project [concat(a#1, ==, note ==) AS x#3], Statistics(sizeInBytes=1.0 GiB)",
      "== note ==",
      ":  +- Relation main.s.a[a#1] parquet, Statistics(sizeInBytes=1.0 GiB)",
      "+- Relation main.s.b[b#2] parquet, Statistics(sizeInBytes=1.0 GiB)",
      "",
      "== Physical Plan ==",
      "Union",
    ].join("\n")
    // The stray line is the rest of the Project above it, not the end of the plan and not a node: the two relations, exactly.
    expect(parseDatabricksExplainCost(plan)).toEqual({ bytes: 2 * 1024 ** 3 })
  })
})

describe("review follow-ups, round four", () => {
  test.each([
    ["snowflake", "select 1\n!foo"],
    ["snowflake", "!set x=1\nselect 1"],
    ["snowflake", "select 1 /* outer /* inner */ */"],
    ["databricks", "select 1 /* outer /* inner */ */"],
  ])("on %s, %p is not read: no estimate", (type, sql) => {
    expect(mayBeScript(sql, type)).toBe(true)
  })

  for (const [type, compiled] of [
    ["snowflake", "select 1\n!foo"],
    ["snowflake", "select 1\r!foo"],
    ["snowflake", "select 1\r\n!foo"],
    ["snowflake", "select 1 /* outer /* inner */ */"],
  ] as const) {
    test(`on ${type}, ${JSON.stringify(compiled)} never reaches the EXPLAIN`, async () => {
      const local: Calls = { nodes: [], queries: [], dryRuns: [] }
      useAdapter(local, { type, compile: async () => compiled, explain: async () => JSON.stringify([SNOWFLAKE_PLAN]) })
      const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
      expect(local.queries).toEqual([])
      expect(result.metadata).toMatchObject({ success: false, source: "explain" })
    })
  }

  test("a ! inside a line is an operator, not a command", () => {
    expect(mayBeScript("select a from t where a != 1", "snowflake")).toBe(false)
  })
})

describe("review follow-ups, round five", () => {
  test.each([
    ["snowflake", "select 1; 'second\nstatement'"],
    ["snowflake", 'select 1; "x"'],
    ["databricks", "select 1; `x`"],
    ["snowflake", "select 1 /*/*/"],
    ["databricks", "select 1 /*/*/ ' */ */ ; delete from t -- '"],
    ["snowflake", "select 1 -- c\r; delete from orders"],
  ])("on %s, %p is not read: no estimate", (type, sql) => {
    expect(mayBeScript(sql, type)).toBe(true)
  })

  test.each([
    ["snowflake", "select 1;;\n"],
    ["snowflake", "select 1; /* done */ -- really"],
  ])("on %s, %p is one statement", (type, sql) => {
    expect(mayBeScript(sql, type)).toBe(false)
  })

  test("quoted text after a semicolon never reaches the EXPLAIN", async () => {
    useAdapter(calls, { type: "snowflake", compile: async () => "select 1; 'second\nstatement'", explain: async () => JSON.stringify([SNOWFLAKE_PLAN]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(calls.queries).toEqual([])
    expect(result.metadata).toMatchObject({ success: false, source: "explain" })
  })

  test.each([
    ["a comma", "Relation main.sales.orders,archive[id#0] parquet, Statistics(sizeInBytes=8.0 EiB)"],
    ["a hyphen", "Relation main.sales.my-table[id#0] parquet, Statistics(sizeInBytes=8.0 EiB)"],
    ["a space", "Relation main.sales.my table[id#0] parquet, Statistics(sizeInBytes=8.0 EiB)"],
    ["a Hive relation", "HiveTableRelation [`spark_catalog`.`default`.`t`, org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe], Statistics(sizeInBytes=8.0 EiB)"],
  ])("a relation whose printed name has %s is not named: Spark prints it unquoted, so it may not be the whole name", (_, leaf) => {
    expect(parseDatabricksExplainCost(`== Optimized Logical Plan ==\n${leaf}`)).toEqual({ noStats: true })
  })

  test("a plain relation name is named in the advice", () => {
    expect(parseDatabricksExplainCost("== Optimized Logical Plan ==\nRelation main.sales.orders[id#0] parquet, Statistics(sizeInBytes=8.0 EiB)")).toEqual({
      noStats: true,
      relation: "main.sales.orders",
    })
  })
})

describe("review follow-ups, round six", () => {
  test("a node continued on a line of its own is one node: its size is not added as a leaf", () => {
    const plan = [
      "== Optimized Logical Plan ==",
      "Project [concat(a#1, line one",
      "line two) AS x#3], Statistics(sizeInBytes=5.0 GiB)",
      "+- Relation main.s.a[a#1] parquet, Statistics(sizeInBytes=1.0 GiB)",
    ].join("\n")
    expect(parseDatabricksExplainCost(plan)).toEqual({ bytes: 1024 ** 3 })
  })

  test.each([
    "select * from read_files('/Volumes/c/s/v/raw', format => 'json')",
    "select * from READ_FILES ('/Volumes/c/s/v/raw')",
    "select * from cloud_files('/mnt/raw', 'json')",
    "select * from json.`/Volumes/c/s/v/raw`",
    "select * from parquet . `s3://bucket/path`",
  ])("on Databricks, %p reads files to plan: no EXPLAIN is sent", async (compiled) => {
    const local: Calls = { nodes: [], queries: [], dryRuns: [] }
    useAdapter(local, { type: "databricks", compile: async () => compiled, explain: async () => JSON.stringify([DATABRICKS_PLAN]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(local.queries).toEqual([])
    expect(result.metadata).toMatchObject({ success: false, adapter: "databricks", source: "explain" })
    expect(result.output).toContain("reads files directly")
  })

  test("a Delta path and a table are still estimated", async () => {
    for (const compiled of ["select * from delta.`/Volumes/c/s/v/t`", "select * from main.sales.orders"]) {
      const local: Calls = { nodes: [], queries: [], dryRuns: [] }
      useAdapter(local, { type: "databricks", compile: async () => compiled, explain: async () => JSON.stringify([DATABRICKS_PLAN]) })
      const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
      expect(result.metadata).toMatchObject({ success: true, source: "explain" })
    }
  })
})

describe("review follow-ups, round seven", () => {
  test.each([
    "select * from read_files/**/('/Volumes/c/s/v/raw', format => 'json')",
    "select * from `read_files`('/x')",
    "select * from read_files -- why\n ('/x')",
    "select * from `json`.`/Volumes/c/s/v/raw`",
    "select * from json/**/.`/x`",
    "select '--', * from read_files('/x')",
    "select * from system.builtin.read_files('/x')",
  ])("%p reads files", (sql) => {
    expect(readsFiles(sql)).toBe(true)
  })

  test.each([
    "select * from main.sales.orders",
    "select t.json.field, text.col from t",
    "select * from delta.`/Volumes/c/s/v/t`",
    "select 'read_files' as note from t",
  ])("%p reads tables", (sql) => {
    expect(readsFiles(sql)).toBe(false)
  })

  test("on Databricks, a comment-split or quoted file read never reaches the EXPLAIN", async () => {
    for (const compiled of ["select * from read_files/**/('/x')", "select * from `json`.`/x`"]) {
      const local: Calls = { nodes: [], queries: [], dryRuns: [] }
      useAdapter(local, { type: "databricks", compile: async () => compiled, explain: async () => JSON.stringify([DATABRICKS_PLAN]) })
      const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
      expect(local.queries).toEqual([])
      expect(result.metadata).toMatchObject({ success: false, adapter: "databricks", source: "explain" })
    }
  })
})

describe("review follow-ups, round eight", () => {
  const escapedNewline = [
    "WITH unused AS (SELECT 'a\\\n-- x' AS s) SELECT * FROM read_files('/x')",
    "SELECT length('a\\\n--') AS n, * FROM read_files('/x', format => 'json')",
  ]

  test.each(escapedNewline)("a backslash before a line break stays inside the text: %p reads files", (sql) => {
    expect(mayBeScript(sql, "databricks")).toBe(false)
    expect(readsFiles(sql)).toBe(true)
  })

  test("so it never reaches the EXPLAIN", async () => {
    for (const compiled of escapedNewline) {
      const local: Calls = { nodes: [], queries: [], dryRuns: [] }
      useAdapter(local, { type: "databricks", compile: async () => compiled, explain: async () => JSON.stringify([DATABRICKS_PLAN]) })
      const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
      expect(local.queries).toEqual([])
      expect(result.metadata).toMatchObject({ success: false, adapter: "databricks", source: "explain" })
    }
  })

  test("both checks read the SQL the same way: one scan", () => {
    expect(scanSql("select `json`.`x` from t -- c\n", "databricks")).toEqual({ script: false, code: "select `json`.`x` from t  ", literals: [], calls: 0 })
    expect(scanSql("select 'a' from t", "databricks").code).toBe("select   from t")
  })
})

describe("review follow-ups, round nine", () => {
  test("a Databricks line comment continued past a backslash is not read", () => {
    const sql = "SELECT 1 -- \\\n'ignored\n, * FROM read_files('/Volumes/c/s/v/raw', format => 'json') -- '"
    expect(mayBeScript(sql, "databricks")).toBe(true)
    expect(readsFiles(sql)).toBe(true)
  })

  test.each([
    "SELECT * FROM libsvm.`s3://bucket/train`",
    "SELECT * FROM somefmt.`dbfs:/mnt/raw`",
    "SELECT * FROM `binaryFile`.`/Volumes/c/s/v/raw`",
  ])("%p reads files", (sql) => {
    expect(readsFiles(sql)).toBe(true)
  })

  test.each([
    "SELECT * FROM delta.`/Volumes/c/s/v/t`",
    "SELECT * FROM sales.`order items`",
    "SELECT * FROM main.sales.`orders`",
  ])("%p reads a table", (sql) => {
    expect(readsFiles(sql)).toBe(false)
  })

  test("a continued comment or a LIBSVM path never reaches the EXPLAIN", async () => {
    for (const compiled of ["SELECT 1 -- \\\n'ignored\n, * FROM read_files('/x') -- '", "SELECT * FROM libsvm.`s3://bucket/train`"]) {
      const local: Calls = { nodes: [], queries: [], dryRuns: [] }
      useAdapter(local, { type: "databricks", compile: async () => compiled, explain: async () => JSON.stringify([DATABRICKS_PLAN]) })
      const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
      expect(local.queries).toEqual([])
      expect(result.metadata).toMatchObject({ success: false, adapter: "databricks", source: "explain" })
    }
  })
})

describe("review follow-ups, round ten", () => {
  test.each([
    "SELECT * FROM `org.apache.spark.sql.json.DefaultSource`.`/Volumes/c/s/v/raw`",
    "SELECT * FROM `org.apache.spark.sql.execution.datasources.json.JsonFileFormat`.`/Volumes/c/s/v/raw`",
    "SELECT * FROM somefmt.`prefix``/raw`",
    "SELECT * FROM delta.`a``/b`",
  ])("%p reads files", (sql) => {
    expect(readsFiles(sql)).toBe(true)
  })

  test("Delta's own provider over a path is still a table", () => {
    expect(readsFiles("SELECT * FROM `delta`.`/Volumes/c/s/v/t`")).toBe(false)
    expect(readsFiles("SELECT * FROM delta . `s3://bucket/t`")).toBe(false)
  })

  test("a provider class name over a path never reaches the EXPLAIN", async () => {
    const local: Calls = { nodes: [], queries: [], dryRuns: [] }
    useAdapter(local, { type: "databricks", compile: async () => "SELECT * FROM `org.apache.spark.sql.json.DefaultSource`.`/Volumes/c/s/v/raw`", explain: async () => JSON.stringify([DATABRICKS_PLAN]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(local.queries).toEqual([])
    expect(result.metadata).toMatchObject({ success: false, adapter: "databricks", source: "explain" })
  })
})

describe("bot review follow-ups", () => {
  test.each([
    "select * from query_audit where sql_text like '%read_files(%'",
    "SELECT * FROM main.json.`orders`",
    "SELECT * FROM main.image.`thumbnails`",
  ])("%p reads a table", (sql) => {
    expect(readsFiles(sql)).toBe(false)
  })

  test.each([
    "SELECT * FROM json.`data.json`",
    "SELECT * FROM t JOIN csv.`rel` ON true",
    "SELECT * FROM a, parquet.`p`",
    "SELECT * FROM system.builtin.read_files('/x')",
  ])("%p reads files", (sql) => {
    expect(readsFiles(sql)).toBe(true)
  })

  test("many backtick-quoted names are read in one pass", () => {
    const sql = `select ${Array.from({ length: 5000 }, (_, i) => `\`c${i}\``).join(", ")} from delta.\`/Volumes/c/s/v/t\``
    const started = performance.now()
    expect(readsFiles(sql)).toBe(false)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe("review follow-ups, round twelve", () => {
  test.each([
    "SELECT * FROM (json.`data.json`)",
    "SELECT * FROM`json`.`data.json`",
    "SELECT * FROM json . `data.json`",
    // A column qualified by an alias named like a format cannot be told from a path query without parsing: refused.
    "SELECT json.`order-id` FROM main.sales.orders AS json",
  ])("%p reads files (or may)", (sql) => {
    expect(readsFiles(sql)).toBe(true)
  })

  test("a parenthesised or unspaced file read never reaches the EXPLAIN", async () => {
    for (const compiled of ["SELECT * FROM (json.`data.json`)", "SELECT * FROM`json`.`data.json`"]) {
      const local: Calls = { nodes: [], queries: [], dryRuns: [] }
      useAdapter(local, { type: "databricks", compile: async () => compiled, explain: async () => JSON.stringify([DATABRICKS_PLAN]) })
      const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
      expect(local.queries).toEqual([])
      expect(result.metadata).toMatchObject({ success: false, adapter: "databricks", source: "explain" })
    }
  })
})

describe("IDENTIFIER() on Databricks", () => {
  test.each([
    "SELECT * FROM IDENTIFIER('read_files')('/Volumes/c/s/v/raw', format => 'json')",
    "SELECT * FROM IDENTIFIER('system.builtin.read_files')('s3://b/x')",
    "SELECT * FROM IDENTIFIER('json.`/Volumes/c/s/v/raw`')",
    "select * from identifier ( 'READ_FILES' ) ('/x')",
    "select * from IDENTIFIER(\"Cloud_Files\")('/x')",
    "select * from IDENTIFIER('system . builtin . `read_files`')('/x')",
    "select * from IDENTIFIER /* c */ ( /* d */ 'CSV.`/x`')",
    "select * from IDENTIFIER('`parquet`.`s3://b/x`')",
    "select * from IDENTIFIER('read' || '_files')('/x')",
    "select * from IDENTIFIER('read_' '' 'files')('/x')",
    "select * from IDENTIFIER(:tbl)",
    "select * from IDENTIFIER(concat('json.`', :p, '`'))",
    "select * from IDENTIFIER(tbl_var)",
    "select * from IDENTIFIER('cat.sch.tbl') a join IDENTIFIER(:other) b on a.id = b.id",
    "select * from IDENTIFIER('read\\_files')('/x')",
    "SELECT * FROM IDENTIFIER(IDENTIFIER('lower')('READ_FILES'))('/Volumes/c/s/v/raw')",
    "SELECT * FROM IDENTIFIER( IDENTIFIER('concat')('read_', 'files'))('/Volumes/c/s/v/raw')",
    "SELECT * FROM IDENTIFIER('read_files /* c */')('/Volumes/c/s/v/raw')",
    "SELECT * FROM IDENTIFIER('read_files/**/')('/Volumes/c/s/v/raw')",
    "SELECT * FROM IDENTIFIER('json/**/.`/Volumes/c/s/v/raw`')",
    "SELECT * FROM IDENTIFIER('read_files -- c\n')('/x')",
    "SELECT * FROM system.builtin.IDENTIFIER('read_files')('/Volumes/c/s/v/raw')",
    "SELECT * FROM json.IDENTIFIER('`/Volumes/c/s/v/raw`')",
    "SELECT * FROM IDENTIFIER('json').`data.json`",
    "SELECT * FROM IDENTIFIER('json') . `data`",
    "SELECT * FROM IDENTIFIER('\"read_files\"')('/Volumes/c/s/v/raw', format => 'json')",
    "SELECT * FROM IDENTIFIER(\"fn\")('/Volumes/c/s/v/raw')",
    "SELECT * FROM \u0131DENTIFIER('read_files')('/Volumes/c/s/v/raw')",
    "SELECT * FROM IDENTIFIER(\"IDENTIFIER('read_files')\")('/Volumes/c/s/v/raw')",
    "SELECT * FROM IDENTIFIER('identifier(''x'')')('/x')",
    "SELECT * FROM IDENTIFIER('read_' /*a*/ || 'files' /*b*/)('/Volumes/c/s/v/raw', format => 'json')",
    "SELECT * FROM IDENTIFIER('`j\u017fon`.`data.json`')",
    "SELECT * FROM IDENTIFIER('${hiveconf:source}')('/Volumes/c/s/v/raw')",
    "SELECT * FROM IDENTIFIER('json.raw')",
    "SELECT * FROM IDENTIFIER(' CSV . raw')",
    "SELECT \u017fIDENTIFIER('safe') FROM IDENTIFIER(concat('read_', 'files'))('/x')",
    "SELECT \u0131DENTIFIER('safe') FROM IDENTIFIER(concat('read_', 'files'))('/x')",
    "SELECT * FROM IDENTIFIER('`org.apache.spark.sql.json.DefaultSource`.`data.json`')",
    "SELECT * FROM IDENTIFIER('`org.apache.spark.sql.json.DefaultSource`.`data.json`')",
    "SELECT * FROM IDENTIFIER('a.b.c.d')",
    "SELECT * FROM IDENTIFIER('js' /*a*/ || 'on.`/Volumes/c/s/v/raw`' /*b*/)",
    "SELECT 1 AS `\u00df\u00df\u00df`, XIDENTIFIER('safe') AS n FROM IDENTIFIER(concat('read_', 'files'))('/x')",
  ])("%p may read files", (sql) => {
    expect(readsFiles(sql)).toBe(true)
  })

  test.each([
    "select * from IDENTIFIER('cat.sch.tbl')",
    "select * from identifier ( 'cat.sch.tbl' ) t where t.x = 'read_files'",
    "select IDENTIFIER('col') from main.sales.orders",
    "select * from IDENTIFIER('main.json.t')",
    "select * from `identifier`('x')",
    "SELECT `note identifier(x)` FROM main.sales.orders",
    `select * from IDENTIFIER${" ".repeat(120)}( 'cat.sch.tbl' )`,
    "select * from IDENTIFIER('main.analytics.identifier_map')",
    "SELECT 1 AS `\u00df\u00df`, XIDENTIFIER('safe') AS n FROM main.sales.orders",
  ])("%p reads tables", (sql) => {
    expect(readsFiles(sql)).toBe(false)
  })

  test.each([
    ["SELECT * FROM IDENTIFIER('system.builtin.read_files')('s3://b/x')", false],
    ["SELECT * FROM IDENTIFIER(:tbl)", false],
    ["SELECT * FROM IDENTIFIER('cat.sch.tbl')", true],
  ])("%p: EXPLAIN sent is %p", async (compiled, explained) => {
    useAdapter(calls, { type: "databricks", compile: async () => compiled, explain: async () => JSON.stringify([DATABRICKS_PLAN]) })
    await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(calls.queries.length > 0).toBe(explained)
  })

  test("repeated comments before a concatenation scan in linear time", () => {
    const sql = "SELECT * FROM IDENTIFIER('read_' " + "/**/".repeat(30) + " || 'files')('/Volumes/c/s/v/raw')"
    const started = performance.now()
    expect(readsFiles(sql)).toBe(true)
    expect(performance.now() - started).toBeLessThan(200)
  })

  test("adjacent ordinary literals scan in linear time", () => {
    const sql = "SELECT " + "'a' ".repeat(64000) + "FROM main.s.t"
    const started = performance.now()
    expect(readsFiles(sql)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("an unbalanced backtick over many slashes scans in linear time", () => {
    const started = performance.now()
    expect(readsFiles("SELECT * FROM IDENTIFIER('`" + "/".repeat(128000) + "')")).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("many ordinary literals scan in linear time", () => {
    const sql = `select ${Array.from({ length: 20000 }, (_, n) => `'v${n}'`).join(", ")} from main.s.t`
    const started = performance.now()
    expect(readsFiles(sql)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("leaves Snowflake and BigQuery alone", async () => {
    expect(scanSql("select * from IDENTIFIER('cat.sch.tbl')", "snowflake").literals).toEqual([])
    expect(scanSql("select * from IDENTIFIER('cat.sch.tbl')", "snowflake").calls).toBe(0)
  })
})
