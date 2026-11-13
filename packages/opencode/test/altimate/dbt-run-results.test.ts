// dbt_run_results reads the last run of a project from fixture run_results.json files: a build
// (nodes that ran), a compile (success rows that ran nothing) and no file at all. No dbt, no warehouse.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { SessionID, MessageID } from "@/session/schema"
import type { Tool } from "@/tool/tool"
import { DbtRunResultsTool } from "@/altimate/tools/dbt-run-results"
import { initTool } from "./tool-fixture"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_dbt_run_results"),
  messageID: MessageID.make("msg_dbt_run_results"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const BUILD = {
  metadata: { invocation_id: "11111111-aaaa-bbbb-cccc-000000000001" },
  args: { which: "build" },
  elapsed_time: 12.5,
  results: [
    { unique_id: "model.shop.stg_orders", status: "error", message: "Database Error: relation missing", execution_time: 1.25 },
    { unique_id: "model.shop.fct_sales", status: "success", message: "CREATE TABLE (10 rows)", execution_time: 3.5 },
    { unique_id: "test.shop.not_null_orders_id.abc", status: "pass", message: null, execution_time: 0.5 },
    { unique_id: "model.shop.dim_accounts.v2", status: "skipped", message: "SKIP", execution_time: 0 },
  ],
}

const COMPILE = {
  metadata: { invocation_id: "22222222-aaaa-bbbb-cccc-000000000002" },
  args: { which: "compile" },
  elapsed_time: 2,
  results: [{ unique_id: "model.shop.fct_sales", status: "success", message: null, execution_time: 0.01 }],
}

let root: string
const run = async (dir: string | undefined) =>
  (await initTool(DbtRunResultsTool)).execute(dir === undefined ? {} : { project_dir: dir }, ctx)

async function project(name: string, artifact?: unknown) {
  const dir = path.join(root, name)
  await mkdir(path.join(dir, "target"), { recursive: true })
  await writeFile(path.join(dir, "dbt_project.yml"), `name: ${name}\n`)
  if (artifact !== undefined) await writeFile(path.join(dir, "target", "run_results.json"), JSON.stringify(artifact))
  return dir
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dbt-run-results-"))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("dbt_run_results", () => {
  test("a build: invocation id, command, elapsed seconds, per-node status, seconds and message", async () => {
    const dir = await project("build", BUILD)
    const when = new Date("2026-11-01T10:00:00.000Z")
    await utimes(path.join(dir, "target", "run_results.json"), when, when)

    const result = await run(dir)

    expect(result.metadata).toEqual({
      truncated: false,
      found: true,
      invocationId: "11111111-aaaa-bbbb-cccc-000000000001",
      command: "build",
      elapsedSec: 12.5,
      completedAt: "2026-11-01T10:00:00.000Z",
      results: [
        { uniqueId: "model.shop.stg_orders", name: "stg_orders", status: "error", executionTimeSec: 1.25, message: "Database Error: relation missing" },
        { uniqueId: "model.shop.fct_sales", name: "fct_sales", status: "success", executionTimeSec: 3.5, message: "CREATE TABLE (10 rows)" },
        { uniqueId: "test.shop.not_null_orders_id.abc", name: "not_null_orders_id", status: "pass", executionTimeSec: 0.5, message: null },
        { uniqueId: "model.shop.dim_accounts.v2", name: "dim_accounts", status: "skipped", executionTimeSec: 0, message: "SKIP" },
      ],
    })
    expect(result.title).toBe("dbt build: 2/4 ok")
    expect(result.output).toContain("error stg_orders 1.25s")
  })

  test("a compile is reported as a compile: its success rows ran nothing", async () => {
    const dir = await project("compile", COMPILE)

    const result = await run(dir)

    expect((result.metadata as any).command).toBe("compile")
    expect((result.metadata as any).invocationId).toBe("22222222-aaaa-bbbb-cccc-000000000002")
    expect((result.metadata as any).results).toHaveLength(1)
  })

  test("no run_results.json: found is false and the answer is empty, not an error", async () => {
    const dir = await project("empty")

    const result = await run(dir)

    expect(result.metadata).toEqual({
      truncated: false,
      found: false,
      invocationId: null,
      command: null,
      elapsedSec: null,
      completedAt: null,
      results: [],
    })
    expect(result.title).toBe("dbt run results: none")
  })

  test("an artifact without an invocation id or timings keeps its rows", async () => {
    const dir = await project("bare", { args: { which: "run" }, results: [{ unique_id: "model.shop.a", status: "success" }] })

    const result = await run(dir)

    expect(result.metadata).toEqual({
      truncated: false,
      found: true,
      invocationId: null,
      command: "run",
      elapsedSec: null,
      completedAt: expect.any(String),
      results: [{ uniqueId: "model.shop.a", name: "a", status: "success", executionTimeSec: null, message: null }],
    })
  })

  test("a long message is cut", async () => {
    const dir = await project("long", {
      metadata: { invocation_id: "x" },
      args: { which: "run" },
      results: [{ unique_id: "model.shop.a", status: "error", message: "e".repeat(5000), execution_time: 1 }],
    })

    const result = await run(dir)

    const message = (result.metadata as any).results[0].message as string
    expect(message.length).toBeLessThan(2100)
    expect(message.endsWith("…")).toBe(true)
  })
})
