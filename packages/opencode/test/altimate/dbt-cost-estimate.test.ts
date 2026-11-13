// dbt_cost_estimate: the dry run's formatted size read back into bytes for each unit, the answer for a
// warehouse with no dry run, a read-only call, and the model's file being compiled. The dbt adapter is
// replaced through `dbtAdapterInternals`, so these tests need no Python, dbt or warehouse.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { dbtAdapterInternals, resetDbtAdapter } from "@/altimate/native/connections/register"
import { DbtCostEstimateTool, parseBytesProcessed } from "@/altimate/tools/dbt-cost-estimate"
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

type Calls = { compiled: [string, string | undefined][]; dryRuns: string[] }

function fakeAdapter(calls: Calls, opts: { type?: string; bytes?: unknown; compileFails?: boolean; dryRunFails?: boolean } = {}) {
  return {
    isInitialized: () => true,
    dispose: async () => {},
    getAdapterType: () => opts.type ?? "bigquery",
    unsafeCompileQuery: async (query: string, name?: string) => {
      calls.compiled.push([query, name])
      if (opts.compileFails) throw new Error("compilation failed")
      return `compiled(${query})`
    },
    validateSQLDryRun: async (query: string) => {
      calls.dryRuns.push(query)
      if (opts.dryRunFails) throw new Error("Access Denied: BigQuery job")
      return { bytes_processed: "bytes" in opts ? opts.bytes : "4.2 TiB" }
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
  await mkdir(path.join(project, "models"), { recursive: true })
  await mkdir(path.join(project, "target"), { recursive: true })
  await writeFile(path.join(project, "models", "orders.sql"), "select * from {{ ref('stg_orders') }}\n")
  await writeFile(
    path.join(project, "target", "manifest.json"),
    JSON.stringify({
      metadata: { adapter_type: "bigquery" },
      nodes: {
        "model.shop.orders": {
          resource_type: "model",
          name: "orders",
          original_file_path: "models/orders.sql",
          raw_code: "select 1 -- stale copy",
        },
        "model.shop.gone": {
          resource_type: "model",
          name: "gone",
          original_file_path: "models/gone.sql",
          raw_code: "select * from {{ source('raw', 'gone') }}",
        },
      },
    }),
  )
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

let calls: Calls
beforeEach(() => {
  resetDbtAdapter()
  calls = { compiled: [], dryRuns: [] }
})
afterEach(() => {
  resetDbtAdapter()
  delete dbtAdapterInternals.readConfig
  delete dbtAdapterInternals.create
})

describe("parseBytesProcessed", () => {
  test.each([
    ["0.0 Bytes", 0],
    ["512.0 Bytes", 512],
    ["1.0 KiB", 1024],
    ["1.5 KiB", 1536],
    ["2.0 MiB", 2 * 1024 ** 2],
    ["4.2 GiB", Math.round(4.2 * 1024 ** 3)],
    ["4.2 TiB", Math.round(4.2 * 1024 ** 4)],
    ["1.0 PiB", 1024 ** 5],
    ["10.5 PiB", Math.round(10.5 * 1024 ** 5)],
    ["  7.0 MiB ", 7 * 1024 ** 2],
  ])("reads %s as %d bytes", (display, bytes) => {
    expect(parseBytesProcessed(display)).toBe(bytes)
  })

  test("takes a number as the count", () => {
    expect(parseBytesProcessed(2048)).toBe(2048)
  })

  test.each([["4.2 EiB"], ["4.2"], ["TiB"], [""], ["about 4 GiB"], ["-1.0 KiB"], [null], [undefined], [{}], [Number.NaN]])(
    "does not read %p",
    (value) => {
      expect(parseBytesProcessed(value)).toBeUndefined()
    },
  )
})

describe("dbt_cost_estimate", () => {
  test("estimates a model from its file, not the manifest's older copy", async () => {
    useAdapter(calls)
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(calls.compiled).toEqual([["select * from {{ ref('stg_orders') }}\n", "orders"]])
    expect(calls.dryRuns).toEqual(["compiled(select * from {{ ref('stg_orders') }}\n)"])
    expect(result.metadata).toMatchObject({
      success: true,
      supported: true,
      adapter: "bigquery",
      bytes: Math.round(4.2 * 1024 ** 4),
      display: "4.2 TiB",
      model: "orders",
    })
    expect(result.output).toContain("orders would process 4.2 TiB")
  })

  test("falls back to the manifest's SQL when the model's file is gone", async () => {
    useAdapter(calls, { bytes: "300.0 MiB" })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "gone" }, ctx)
    expect(calls.compiled).toEqual([["select * from {{ source('raw', 'gone') }}", "gone"]])
    expect(result.metadata.bytes).toBe(300 * 1024 ** 2)
  })

  test("estimates SQL as given", async () => {
    useAdapter(calls, { bytes: "1.0 GiB" })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select 1" }, ctx)
    expect(calls.compiled).toEqual([["select 1", undefined]])
    expect(result.metadata).toMatchObject({ supported: true, bytes: 1024 ** 3, display: "1.0 GiB" })
    expect(result.metadata.model).toBeUndefined()
  })

  test.each(["snowflake", "databricks", "duckdb"])("answers supported:false on %s and compiles nothing", async (type) => {
    useAdapter(calls, { type })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "orders" }, ctx)
    expect(result.metadata).toMatchObject({ success: true, supported: false, adapter: type })
    expect(result.metadata.bytes).toBeUndefined()
    expect(result.output).toContain("only available on BigQuery")
    expect(calls).toEqual({ compiled: [], dryRuns: [] })
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
    expect(calls).toEqual({ compiled: [], dryRuns: [] })
  })

  test("names a model the manifest doesn't have", async () => {
    useAdapter(calls)
    const result = await (await initTool(DbtCostEstimateTool)).execute({ model: "nope" }, ctx)
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain('no model "nope"')
    expect(calls).toEqual({ compiled: [], dryRuns: [] })
  })

  test("reports a compile error without a dry run", async () => {
    useAdapter(calls, { compileFails: true })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select" }, ctx)
    expect(result.metadata).toMatchObject({ success: false, error: "compilation failed" })
    expect(calls.dryRuns).toEqual([])
  })

  test("reports a dry run the warehouse refused", async () => {
    useAdapter(calls, { dryRunFails: true })
    const result = await (await initTool(DbtCostEstimateTool)).execute({ sql: "select 1" }, ctx)
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
