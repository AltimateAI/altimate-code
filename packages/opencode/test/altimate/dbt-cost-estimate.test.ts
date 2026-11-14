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
import { DbtCostEstimateTool, parseBytesProcessed, untilAbort } from "@/altimate/tools/dbt-cost-estimate"
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
  opts: { type?: string; bytes?: unknown; compileFails?: boolean; dryRunFails?: boolean; compile?: () => Promise<string> } = {},
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

  test.each(["snowflake", "databricks", "duckdb"])("answers supported:false on %s and compiles nothing", async (type) => {
    useAdapter(calls, { type })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata).toMatchObject({ success: true, supported: false, adapter: type })
    expect(result.metadata.bytes).toBeUndefined()
    expect(result.output).toContain("only available on BigQuery")
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
})
