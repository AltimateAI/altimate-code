// dbt_cost_estimate: the dry run's formatted size read back into bytes (and its upper bound) for each unit,
// the answer for a warehouse with no dry run, a read-only call, and a model compiled by name. The dbt adapter is
// replaced through `dbtAdapterInternals`, so these tests need no Python, dbt or warehouse.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { dbtAdapterInternals, resetDbtAdapter } from "@/altimate/native/connections/register"
import { DbtCostEstimateTool, parseBytesProcessed, untilAbort } from "@/altimate/tools/dbt-cost-estimate"
import { costHistoryInternals } from "@/altimate/tools/dbt-cost-history"
import { tmpdir } from "../fixture/fixture"
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
let projectDir: Awaited<ReturnType<typeof tmpdir>>
/** The history queries (as Jinja) the tool sent through the adapter. */
let historyLog: string[] = []
const defaultReadCostConfig = costHistoryInternals.readCostConfig
const defaultNow = costHistoryInternals.now

/** What the history Jinja renders: the columns and rows of a table, every value text or null. */
function table(columns: string[], rows: (string | null)[][]) {
  return JSON.stringify({ columns, rows })
}

type Calls = { nodes: string[]; queries: [string, string | undefined][]; dryRuns: string[] }

function fakeAdapter(
  calls: Calls,
  opts: {
    type?: string
    bytes?: unknown
    compileFails?: boolean
    dryRunFails?: boolean
    compile?: () => Promise<string>
    /** The table a history query renders (see `table`), or a failure to throw; the SQL it was asked is passed in. */
    history?: (jinja: string) => Promise<string>
    /** What the boundary query (the matching statements just before the period read) renders; none by default. */
    boundary?: (jinja: string) => Promise<string>
    /** What the dbt target renders. */
    target?: string
    /** The manifest path the adapter reports (`getManifestPath`), as the project's own adapter does. */
    manifestPath?: string
  } = {},
) {
  return {
    isInitialized: () => true,
    dispose: async () => {},
    getAdapterType: () => opts.type ?? "bigquery",
    ...(opts.manifestPath ? { getManifestPath: () => opts.manifestPath } : {}),
    unsafeCompileNode: async (model: string) => {
      calls.nodes.push(model)
      if (opts.compile) return opts.compile()
      if (opts.compileFails) throw new Error("compilation failed")
      return `compiled(${model})`
    },
    unsafeCompileQuery: async (query: string, name?: string) => {
      if (query.startsWith("{%- if execute -%}{%- set altimate_rows")) {
        historyLog.push(query)
        if (query.includes("/* run boundary */"))
          return opts.boundary ? opts.boundary(query) : table(["session_id", "creation_time", "start_time", "end_time"], [])
        if (opts.history) return opts.history(query)
        throw new Error("no history in this test")
      }
      if (query.startsWith('{{ tojson({"project"')) {
        return opts.target ?? '{"project": "p1", "execution_project": null, "location": "EU"}'
      }
      calls.queries.push([query, name])
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
  projectDir = await tmpdir()
  project = projectDir.path
  await writeFile(path.join(project, "dbt_project.yml"), "name: shop\n")
  await mkdir(path.join(project, "target"))
  const model = (pkg: string, name: string, materialized: string, deps: string[] = []) => [
    `model.${pkg}.${name}`,
    { resource_type: "model", name, config: { materialized }, depends_on: { nodes: deps } },
  ]
  await writeFile(
    path.join(project, "target", "manifest.json"),
    JSON.stringify({
      nodes: Object.fromEntries([
        model("shop", "orders", "incremental", ["model.shop.stg_orders", "source.shop.raw.items"]),
        model("shop", "stg_orders", "table", ["source.shop.raw.orders"]),
        model("shop", "dup", "table"),
        model("other", "dup", "table"),
        model("shop", "mart", "table", ["model.shop.stg_orders"]),
        model("shop", "lonely", "table"),
      ]),
      sources: { "source.shop.raw.orders": {}, "source.shop.raw.items": {} },
    }),
  )
})

afterAll(async () => {
  await projectDir[Symbol.asyncDispose]()
})

let calls: Calls
beforeEach(() => {
  resetDbtAdapter()
  calls = { nodes: [], queries: [], dryRuns: [] }
  historyLog = []
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
      cost: expect.objectContaining({ basis: "none" }),
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
      cost: expect.objectContaining({ basis: "none" }),
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
      cost: expect.objectContaining({ basis: "none" }),
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

  test.each(["snowflake", "databricks", "duckdb", "redshift", "postgres"])("answers supported:false on %s, which is not BigQuery, and compiles nothing", async (type) => {
    useAdapter(calls, { type })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata).toMatchObject({ success: true, supported: false, adapter: type })
    expect(result.metadata.bytes).toBeUndefined()
    expect(result.output).toBe(`No cost estimate: cost estimates are only available on BigQuery (this project uses ${type}).`)
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

const JOB_COLUMNS = ["job_id", "user_email", "creation_time", "end_time", "statement_type", "destination_table_id", "total_bytes_billed", "total_slot_ms", "reservation_id", "cache_hit"]
const CHILD_COLUMNS = ["job_id", "parent_job_id", "creation_time", "statement_type", "total_bytes_billed", "total_slot_ms", "reservation_id", "cache_hit"]
const TIB = 1024 ** 4
const job = (
  id: string,
  start: string,
  end: string,
  billed: number | null,
  reservation: string | null = null,
  slotMs = 0,
  type = "MERGE",
  user = "a@x.com",
  destination: string | null = null,
) => [
  id,
  user,
  start,
  end,
  type,
  destination,
  billed === null ? null : String(billed),
  String(slotMs),
  reservation,
  "False",
]

/**
 * A history answer: `jobs` for the history query, `children` for the script-children query, and the capacity check
 * counts `reserved` of `total` query jobs. `denyJobs` refuses the project-wide view, as a role without listAll is.
 */
const bigqueryHistory =
  (jobs: (string | null)[][], opts: { reserved?: string; total?: string; children?: (string | null)[][]; denyJobs?: boolean } = {}) =>
  async (jinja: string) => {
    if (opts.denyJobs && /INFORMATION_SCHEMA\.JOBS\n|INFORMATION_SCHEMA\.JOBS\s/.test(jinja.replace(/\\n/g, "\n")) && !jinja.includes("JOBS_BY_USER"))
      throw new Error("Access Denied: Table region-eu.INFORMATION_SCHEMA.JOBS: User does not have permission")
    if (jinja.includes("countif(reservation_id")) return table(["jobs", "reserved"], [[opts.total ?? "10", opts.reserved ?? "0"]])
    if (jinja.includes("parent_job_id in (")) return table(CHILD_COLUMNS, opts.children ?? [])
    return table(JOB_COLUMNS, jobs)
  }

describe("dbt_cost_estimate cost", () => {
  afterEach(() => {
    costHistoryInternals.historyTimeoutMs = 60_000
  })

  test("BigQuery on demand: earlier runs are read from the jobs view, a delete joins the build that follows it, and the cost leads the answer", async () => {
    useAdapter(calls, {
      history: bigqueryHistory([
        // The newest run: a delete and the merge that follows it. The older run is a day before.
        job("a2", "2026-05-02 10:00:30+00:00", "2026-05-02 10:01:30+00:00", 2 * TIB),
        job("a1", "2026-05-02 10:00:00+00:00", "2026-05-02 10:01:00+00:00", 1 * TIB, null, 0, "DELETE"),
        job("b1", "2026-05-01 10:00:00+00:00", "2026-05-01 10:01:00+00:00", 4 * TIB),
      ]),
    })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    const cost = result.metadata.cost
    expect(cost).toMatchObject({
      basis: "history",
      currency: "USD",
      runs: 2,
      windowDays: 30,
      lastRun: 3 * 6.25,
      typical: (3 * 6.25 + 4 * 6.25) / 2,
      highest: 4 * 6.25,
      native: { unit: "bytes_billed", lastRun: 3 * TIB, highest: 4 * TIB },
      rate: { value: 6.25, unit: "USD/TiB", source: "default" },
    })
    // The manifest lists two tables: the floor is one query's 10 MiB; the high figure is the dry run's upper bound (4.25 TiB, the rounding edge) plus them.
    const bytes = Math.round(4.2 * TIB)
    expect(cost.selectOnly.low).toBeCloseTo(((10 * 1024 ** 2) / TIB) * 6.25, 10)
    expect(cost.selectOnly.high).toBeCloseTo(((Math.ceil(4.25 * TIB) + 2 * 10 * 1024 ** 2) / TIB) * 6.25, 4)
    expect(cost.selectOnly.high).toBeGreaterThan((bytes / TIB) * 6.25)
    expect(cost.notes.join(" ")).toContain("A source that is a view in BigQuery bills 10 MiB more")
    // A source may be a view that bills more per table: the high figure is no ceiling.
    expect(cost.selectOnly.perTable).toBeGreaterThan(0)
    expect(result.output.startsWith("Cost from 2 runs in the last 30 days: last run $18.75")).toBe(true)
    expect(result.output).toContain("would process 4.2 TiB")
    expect(result.metadata).toMatchObject({ supported: true, bytes, display: "4.2 TiB", model: "orders" })
  })

  test("the scan figure is computed first: no adapter call for the target or the history starts before the dry run has finished", async () => {
    let dryRunDone = false
    const started: boolean[] = []
    const base = fakeAdapter(calls, { history: bigqueryHistory([]) })
    useAdapter(calls)
    dbtAdapterInternals.create = async () => ({
      ...base,
      unsafeCompileQuery: async (q: string, name?: string) => {
        if (q.startsWith('{{ tojson({"project"') || q.startsWith("{%- if execute -%}{%- set altimate_rows")) started.push(dryRunDone)
        return base.unsafeCompileQuery(q, name)
      },
      validateSQLDryRun: async (q: string) => {
        const answer = await base.validateSQLDryRun(q)
        // Hold the dry run: a lookup that started beside it would see dryRunDone still false.
        await new Promise((r) => setTimeout(r, 25))
        dryRunDone = true
        return answer
      },
    })
    await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(started.length).toBeGreaterThan(1)
    expect(started.every(Boolean)).toBe(true)
  })

  test("a history that fails never changes the scan figure", async () => {
    useAdapter(calls, {})
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata).toMatchObject({ success: true, bytes: Math.round(4.2 * TIB), display: "4.2 TiB" })
  })

  test("BigQuery asks the project and region of the dbt target, for exactly this model's unique_id", async () => {
    useAdapter(calls, {
      history: bigqueryHistory([]),
      target: '{"project": "data", "execution_project": "billing-proj", "location": "EU"}',
    })
    await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    const sql = historyLog.find((q) => q.includes("total_bytes_billed") && q.includes("strpos"))!
    expect(sql).toContain("`billing-proj`.`region-eu`.INFORMATION_SCHEMA.JOBS")
    // Inside the Jinja string the SQL's own quotes are escaped once more.
    expect(sql).toContain("strpos(query, \\'\"node_id\": \"model.shop.orders\"\\') > 0")
    expect(sql).toContain("parent_job_id is null")
  })

  test("BigQuery capacity jobs are priced by slot time, with the caveat", async () => {
    useAdapter(calls, {
      history: bigqueryHistory([job("c1", "2026-05-02 10:00:00+00:00", "2026-05-02 10:01:00+00:00", 5 * TIB, "res-1", 7_200_000)], { reserved: "3" }),
    })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    const cost = result.metadata.cost
    expect(cost).toMatchObject({
      basis: "history",
      lastRun: 2 * 0.06,
      native: { unit: "slot_hours", lastRun: 2 },
      rate: { value: 0.06, unit: "USD/slot-hour", source: "default" },
    })
    expect(cost.notes.join(" ")).toContain("not each job")
  })

  test("BigQuery: the CTAS into dbt's temporary relation and the MERGE after it are one run through the tool", async () => {
    useAdapter(calls, {
      history: bigqueryHistory([
        job("m", "2026-05-02 10:03:00+00:00", "2026-05-02 10:04:00+00:00", 2 * TIB),
        job("t", "2026-05-02 10:00:00+00:00", "2026-05-02 10:01:00+00:00", TIB, null, 0, "CREATE_TABLE_AS_SELECT", "a@x.com", "orders__dbt_tmp"),
      ]),
    })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata.cost).toMatchObject({ basis: "history", runs: 1 })
    expect(result.metadata.cost.lastRun).toBeCloseTo(18.75, 10)
  })

  test("script children are read from the earliest parent's creation, so a child cannot slide out of a moving window", async () => {
    const parent = Date.parse("2026-05-02T10:00:01Z")
    const kids = [
      ["k1", "p1", "2026-05-02 10:00:03+00:00", "CREATE_TABLE_AS_SELECT", String(TIB), "0", null, "False"],
      ["k2", "p1", "2026-05-02 10:00:11+00:00", "MERGE", String(TIB), "0", null, "False"],
    ]
    useAdapter(calls, {
      history: async (jinja) => {
        if (!jinja.includes("parent_job_id in (")) return bigqueryHistory([job("p1", "2026-05-02 10:00:01+00:00", "2026-05-02 10:00:20+00:00", 9 * TIB, null, 0, "SCRIPT")])(jinja)
        // An adapter consistent with the SQL: a lower bound at the parent's creation keeps both children; a sliding
        // window (current_timestamp minus 30 days) has already moved 5 s past the parent's start and loses the first.
        const fixed = /creation_time >= timestamp_millis\((\d+)\)/.exec(jinja)
        const lower = fixed ? Number(fixed[1]) : parent + 5_000
        return table(CHILD_COLUMNS, kids.filter((k) => Date.parse(String(k[2]).replace(" ", "T")) >= lower))
      },
    })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata.cost).toMatchObject({ runs: 1 })
    expect(result.metadata.cost.lastRun).toBeCloseTo(12.5, 10)
  })

  test("the tool description calls the cost reported usage at a stated rate, not what the warehouse billed", async () => {
    const tool = await initTool(DbtCostEstimateTool)
    expect(tool.description).not.toContain("what the warehouse billed")
    expect(tool.description).toContain("stated rate")
    expect(tool.description).toContain("not an invoice amount")
  })

  test("the SELECT's price is in the output beside the history it is a note about", async () => {
    useAdapter(calls, { history: bigqueryHistory([job("a", "2026-05-02 10:00:00+00:00", "2026-05-02 10:01:00+00:00", TIB)]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "mart" }, ctx)
    expect(result.output).toContain("Cost from 1 run")
    expect(result.output).toContain("The SELECT would bill $")
    expect(result.output).toContain("The price covers the SELECT only")
  })

  test("the manifest the adapter reports is the one the model is looked up in", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "manifest.json")
    await writeFile(file, JSON.stringify({ nodes: { "model.other.custom": { resource_type: "model", name: "custom", config: {}, depends_on: { nodes: [] } } }, sources: {} }))
    useAdapter(calls, { manifestPath: file, history: bigqueryHistory([job("a", "2026-05-02 10:00:00+00:00", "2026-05-02 10:01:00+00:00", TIB)]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "custom" }, ctx)
    expect(result.metadata.cost).toMatchObject({ basis: "history", runs: 1 })
    expect(historyLog.some((q) => q.includes("model.other.custom"))).toBe(true)
  })

  test("a manifest that cannot be read leaves the scan figure and names the problem", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "manifest.json")
    await writeFile(file, "{ broken")
    useAdapter(calls, { manifestPath: file, history: bigqueryHistory([]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata).toMatchObject({ success: true, bytes: Math.round(4.2 * TIB) })
    expect(result.metadata.cost.notes.join(" ")).toContain("could not be read")
  })

  test("a script is priced from its child jobs, which carry the reservation the script row lacks", async () => {
    useAdapter(calls, {
      history: bigqueryHistory([job("p1", "2026-05-02 10:00:00+00:00", "2026-05-02 10:05:00+00:00", 9 * TIB, null, 0, "SCRIPT")], {
        reserved: "2",
        children: [
          ["k1", "p1", "2026-05-02 10:00:10+00:00", "CREATE_TABLE_AS_SELECT", "0", "3600000", "res", "False"],
          ["k2", "p1", "2026-05-02 10:01:00+00:00", "MERGE", "0", "3600000", "res", "False"],
        ],
      }),
    })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    const cost = result.metadata.cost
    expect(cost).toMatchObject({ runs: 1, native: { unit: "slot_hours", lastRun: 2 } })
    expect(cost.lastRun).toBeCloseTo(0.12, 10)
    expect(historyLog.some((q) => q.includes("parent_job_id in (\\'p1\\')"))).toBe(true)
  })

  test("a project on capacity pricing does not get the dry run priced", async () => {
    useAdapter(calls, { history: bigqueryHistory([], { reserved: "5" }) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    const cost = result.metadata.cost
    expect(cost.selectOnly).toBeUndefined()
    expect(cost.basis).toBe("none")
    expect(cost.notes.join(" ")).toContain("capacity pricing")
    expect(result.output).toContain("would process 4.2 TiB")
    expect(cost.rate).toBeNull()
    expect(result.output).not.toContain("Rate:")
  })

  test("an on-demand dry run is priced as a range, with each table's 10 MiB minimum, and says it covers the SELECT only", async () => {
    useAdapter(calls, { bytes: "1.0 KiB", history: bigqueryHistory([]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "stg_orders" }, ctx)
    const cost = result.metadata.cost
    expect(cost.basis).toBe("dry_run")
    const tenMiB = 10 * 1024 ** 2
    expect(cost.selectOnly.low).toBeCloseTo((tenMiB / TIB) * 6.25, 10)
    // "1.0 KiB" is rounded: the dry run can have read up to 1.05 KiB.
    expect(cost.selectOnly.high).toBeCloseTo(((Math.ceil(1.05 * 1024) + tenMiB) / TIB) * 6.25, 9)
    expect(cost.notes.join(" ")).toContain("SELECT only")
    expect(cost.notes.join(" ")).toContain("No runs of model.shop.stg_orders in the last 30 days")
    // stg_orders reads a source, which may be a view: the figure is no ceiling.
    expect(result.output).toContain("The SELECT would bill $")
    expect(result.output).toContain("for each further table the query reads")
    expect(result.output).toContain("pruning of clustered or partitioned tables can bill less")
  })

  test.each([
    ["a script", "select 1; select * from big", "1.0 GiB", "The dry run covers only the first statement, so it is not priced."],
    ["a zero estimate", "select 1", 0, "The dry run reported 0 bytes, which BigQuery also reports for sources it cannot size"],
  ])("%s: a dry run that is only a lower bound is not priced, with its own reason", async (_name, sql, bytes, reason) => {
    useAdapter(calls, { bytes, history: bigqueryHistory([]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql }, ctx)
    const cost = result.metadata.cost
    expect(result.metadata).toMatchObject({ lowerBound: true })
    expect(cost.selectOnly).toBeUndefined()
    expect(cost.basis).toBe("none")
    expect(cost.notes.join(" ")).toContain(reason)
    // The other reason does not apply.
    const other = reason.startsWith("The dry run covers") ? "reported 0 bytes" : "covers only the first statement"
    expect(cost.notes.join(" ")).not.toContain(other)
  })

  test("when neither the project's jobs nor the caller's own say the pricing mode, the dry run is not priced and the scan stays", async () => {
    useAdapter(calls, {
      history: async (jinja) => {
        if (jinja.includes("countif(reservation_id")) throw new Error("boom")
        return table(JOB_COLUMNS, [])
      },
    })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "stg_orders" }, ctx)
    const cost = result.metadata.cost
    expect(cost.selectOnly).toBeUndefined()
    expect(cost.basis).toBe("none")
    expect(cost.unknownReason).toContain("BigQuery pricing mode could not be read (on-demand vs reservations)")
    expect(result.metadata).toMatchObject({ success: true, bytes: Math.round(4.2 * TIB) })
  })

  test("no query job in the last week is no pricing mode either", async () => {
    useAdapter(calls, { history: bigqueryHistory([], { total: "0" }) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "stg_orders" }, ctx)
    expect(result.metadata.cost.selectOnly).toBeUndefined()
    expect(result.metadata.cost.unknownReason).toContain("pricing mode could not be read")
  })

  test("a role without listAll falls back to its own jobs and says only its own runs were read", async () => {
    useAdapter(calls, {
      history: bigqueryHistory([job("a", "2026-05-02 10:00:00+00:00", "2026-05-02 10:01:00+00:00", TIB)], { denyJobs: true }),
    })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    const cost = result.metadata.cost
    expect(historyLog.some((q) => q.includes("JOBS_BY_USER") && q.includes("strpos"))).toBe(true)
    expect(cost).toMatchObject({ basis: "history", lastRun: 6.25 })
    expect(cost.notes.join(" ")).toContain("Only your own runs were read")
  })

  test("a history the role cannot read at all leaves the scan figure and says what is missing", async () => {
    useAdapter(calls, {
      history: async () => {
        throw new Error("Access Denied: Table region-eu.INFORMATION_SCHEMA.JOBS: User does not have permission")
      },
    })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata).toMatchObject({ success: true, supported: true, bytes: Math.round(4.2 * TIB), display: "4.2 TiB" })
    const cost = result.metadata.cost
    expect(cost.unknownReason).toContain("bigquery.jobs.listAll")
    expect(cost.runs).toBeUndefined()
    expect(result.output).toContain("would process 4.2 TiB")
  })

  test("a history that never answers is bounded, and the scan figure still comes back", async () => {
    costHistoryInternals.historyTimeoutMs = 30
    useAdapter(calls, { history: () => new Promise(() => {}) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata).toMatchObject({ success: true, bytes: Math.round(4.2 * TIB) })
    expect(result.metadata.cost.unknownReason).toContain("did not answer within 0.03 s")
  })

  test("SQL input has no history to read", async () => {
    useAdapter(calls, { history: bigqueryHistory([job("a", "2026-05-02 10:00:00+00:00", "2026-05-02 10:01:00+00:00", TIB)]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select 1" }, ctx)
    expect(historyLog.some((q) => q.includes("total_bytes_billed") && q.includes("strpos"))).toBe(false)
    const cost = result.metadata.cost
    expect(cost.basis).toBe("dry_run")
    expect(cost.runs).toBeUndefined()
    expect(cost.notes.join(" ")).toContain("A SQL input has no run history")
    // The number of tables is unknown for SQL: one is assumed, and the high figure is no "at most".
    expect(cost.notes.join(" ")).toContain("1 table counted: the input is SQL, which has no manifest entry, so at least one is assumed")
    expect(cost.notes.join(" ")).not.toContain("0 tables")
    expect(cost.selectOnly.perTable).toBeCloseTo(((10 * 1024 ** 2) / TIB) * 6.25, 12)
    expect(result.output).toContain("for each further table the query reads")
    expect(result.output).not.toContain("would bill at most")
  })

  test("a model name that matches two nodes is reported ambiguous and no history is read", async () => {
    useAdapter(calls, { history: bigqueryHistory([]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "dup" }, ctx)
    expect(historyLog.some((q) => q.includes("total_bytes_billed") && q.includes("strpos"))).toBe(false)
    const notes = result.metadata.cost.notes.join(" ")
    expect(notes).toContain("model.other.dup")
    expect(notes).toContain("model.shop.dup")
  })

  test("the manifest's dependency count is never exact: even a plain one-table model has no ceiling, and the floor is one query's minimum", async () => {
    useAdapter(calls, { history: bigqueryHistory([]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "mart" }, ctx)
    const { low, perTable } = result.metadata.cost.selectOnly
    expect(perTable).toBeCloseTo(((10 * 1024 ** 2) / TIB) * 6.25, 12)
    expect(low).toBeCloseTo(perTable, 12)
    expect(result.output).toContain("for each further table the query reads")
    expect(result.output).not.toContain("would bill at most")
    expect(result.metadata.cost.notes.join(" ")).toContain("1 table counted; the manifest's dependencies may differ from the tables the query reads")
  })

  test("a model with several dependencies keeps the one-query floor, so a dependency that is not read cannot raise it", async () => {
    useAdapter(calls, { history: bigqueryHistory([]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    const { low, high } = result.metadata.cost.selectOnly
    expect(low).toBeCloseTo(((10 * 1024 ** 2) / TIB) * 6.25, 12)
    expect(high).toBeGreaterThan(low)
  })

  test("an ambiguous model name is blamed for the missing table count, not SQL input", async () => {
    useAdapter(calls, { history: bigqueryHistory([]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "dup" }, ctx)
    const notes = result.metadata.cost.notes.join(" ")
    expect(notes).toContain("1 table counted: dup is ambiguous")
    expect(notes).not.toContain("the input is SQL")
    expect(notes).not.toContain("0 tables")
  })

  test("a model with no relation found in the manifest says one is assumed, never '0 tables'", async () => {
    useAdapter(calls, { history: bigqueryHistory([]) })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "lonely" }, ctx)
    const notes = result.metadata.cost.notes.join(" ")
    expect(notes).toContain("1 table counted: none was found in the manifest, so one is assumed")
    expect(notes).not.toContain("0 tables")
    expect(result.metadata.cost.selectOnly.perTable).toBeGreaterThan(0)
  })

  test("an incremental model's scan figure says it leaves out the MERGE; a table model's does not", async () => {
    useAdapter(calls, { history: bigqueryHistory([]) })
    const tool = await initTool(DbtCostEstimateTool)
    const incremental = (await tool.execute({ model: "orders" }, ctx)).metadata
    const table_ = (await tool.execute({ model: "stg_orders" }, ctx)).metadata
    expect(incremental.cost.notes.join(" ")).toContain("incremental")
    expect(table_.cost.notes.join(" ")).not.toContain("incremental")
  })

  test("a rate from the config replaces the default and is named", async () => {
    costHistoryInternals.readCostConfig = async () => ({ bigqueryUsdPerTib: 5 })
    try {
      useAdapter(calls, {
        history: bigqueryHistory([job("a", "2026-05-02 10:00:00+00:00", "2026-05-02 10:01:00+00:00", TIB)]),
      })
      const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
      expect(result.metadata.cost).toMatchObject({ lastRun: 5, rate: { value: 5, source: "config" } })
    } finally {
      costHistoryInternals.readCostConfig = defaultReadCostConfig
    }
  })

  test("one instant for the whole BigQuery call: capacity, history and boundary share it", async () => {
    let asked = 0
    const asOf = Date.UTC(2026, 5, 1, 20, 0, 0)
    costHistoryInternals.now = () => (asked++, asOf + asked * 5_000)
    try {
      useAdapter(calls, {
        history: bigqueryHistory([job("p1", "2026-05-20 10:00:00+00:00", "2026-05-20 10:01:00+00:00", 9 * TIB, null, 0, "SCRIPT")], {
          children: [["k1", "p1", "2026-05-20 10:00:05+00:00", "MERGE", String(TIB), "0", null, "False"]],
        }),
      })
      await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
      const start = asOf + 5_000 - 30 * 86_400_000
      expect(asked).toBe(1)
      for (const q of historyLog) expect(q).not.toMatch(/current_(timestamp|date)/)
      expect(historyLog.find((q) => q.includes("countif(reservation_id"))).toContain(`timestamp_millis(${asOf + 5_000 - 7 * 86_400_000})`)
      expect(historyLog.find((q) => q.includes("strpos") && !q.includes("run boundary"))).toContain(`timestamp_millis(${start})`)
      expect(historyLog.find((q) => q.includes("run boundary"))).toContain(`timestamp_millis(${start + 1})`)
    } finally {
      costHistoryInternals.now = defaultNow
    }
  })

  describe("a statement that starts exactly at the window's start", () => {
    // The main read takes statements after the window's start, so one exactly at it is only in the boundary read, which
    // must reach it: an adapter consistent with the SQL returns a statement iff it starts before the literal it is given.
    const asOf = Date.UTC(2026, 5, 1, 20, 0, 0)
    const start = asOf - 30 * 86_400_000
    const iso = (ms: number) => new Date(ms).toISOString()
    const before = (jinja: string, pattern: RegExp) => start < Number(pattern.exec(jinja)![1])
    const withNow = async (run: () => Promise<void>) => {
      costHistoryInternals.now = () => asOf
      try {
        await run()
      } finally {
        costHistoryInternals.now = defaultNow
      }
    }

    test("BigQuery", async () => {
      await withNow(async () => {
        useAdapter(calls, {
          history: bigqueryHistory([job("m", iso(start + 30_000), iso(start + 90_000), TIB)]),
          boundary: async (jinja) =>
            table(["job_id", "user_email", "creation_time", "end_time", "statement_type"], before(jinja, /creation_time < timestamp_millis\((\d+)\)/) ? [["edge", "a@x.com", iso(start), iso(start + 5_000), "DELETE"]] : []),
        })
        const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
        // The only run is left out, so the cost is the dry run alone.
        expect(result.metadata.cost.runs).toBeUndefined()
        expect(result.metadata.cost.basis).toBe("dry_run")
        expect(result.metadata.cost.notes.join(" ")).toContain("1 run that may have started before the period read was left out.")
      })
    })
  })

  describe("a boundary statement created exactly at the cutoff less the attach window", () => {
    // 500 statements were returned, so the cutoff is the oldest one's start. An unread delete created exactly the attach
    // window before the oldest run still belongs to it (a gap of exactly the limit joins); one a millisecond earlier does
    // not. An adapter consistent with the SQL returns a statement iff it is created before the start literal and at or
    // after the attach literal.
    // The oldest statement is five days before the as-of instant; the fillers follow it, 14.4 minutes apart, all before it.
    const asOf = Date.UTC(2026, 4, 15)
    const T0 = asOf - 5 * 86_400_000
    const step = 864_000
    const iso = (ms: number) => new Date(ms).toISOString()
    const withNow = async (run: () => Promise<void>) => {
      costHistoryInternals.now = () => asOf
      try {
        await run()
      } finally {
        costHistoryInternals.now = defaultNow
      }
    }
    const lit = (jinja: string, pattern: RegExp) => Number(pattern.exec(jinja)![1])

    test.each([
      ["BigQuery attach window", 60_000, true],
      ["BigQuery attach window, a millisecond earlier", 60_001, false],
    ])("%s (a delete created exactly that long before the cutoff)", async (_name, before, dropped) => {
      await withNow(async () => {
        const rows = [
          job("old", iso(T0), iso(T0 + 60_000), TIB),
          ...Array.from({ length: 499 }, (_, i) => job(`f${i}`, iso(T0 + (i + 1) * step), iso(T0 + (i + 1) * step + 60_000), TIB, null, 0, "MERGE", `u${i}@x.com`)),
        ]
        useAdapter(calls, {
          history: bigqueryHistory(rows),
          boundary: async (jinja) => {
            const s = lit(jinja, /creation_time < timestamp_millis\((\d+)\)/)
            const d = lit(jinja, /creation_time >= timestamp_millis\((\d+)\)/)
            const created = T0 - before
            return table(["job_id", "user_email", "creation_time", "end_time", "statement_type"], created < s && created >= d ? [["edge", "a@x.com", iso(created), iso(created + 1_000), "DELETE"]] : [])
          },
        })
        const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
        expect(result.metadata.cost.runs).toBe(dropped ? 499 : 500)
      })
    })
  })

  const DBX_COLUMNS = ["statement_id", "session_id", "start_time", "end_time", "statement_type", "warehouse_id", "total_task_duration_ms", "dbus", "usd", "missing_hours"]

})

describe("cost config", () => {
  test("the cost block holds the BigQuery rates only, each a positive number", async () => {
    const { ConfigV1 } = await import("@opencode-ai/core/v1/config/config")
    const { Schema } = await import("effect")
    const doc = Schema.toJsonSchemaDocument(ConfigV1.Info)
    const text = JSON.stringify(doc)
    expect(text).not.toContain("snowflakeUsdPerCredit")
    expect(text).not.toContain("databricksUsdPerDbu")
    for (const key of ["bigqueryUsdPerTib", "bigquerySlotHourUsd"]) {
      const own = new RegExp(`"${key}":.*?"description":"([^"]*)"`).exec(text)
      expect(own?.[1]).toContain("a positive number")
    }
  })
})
