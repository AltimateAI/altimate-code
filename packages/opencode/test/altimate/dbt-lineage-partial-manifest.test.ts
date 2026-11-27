// altimate_change - new file
//
// dbt_lineage's note when the running dbt adapter's last parse had errors (dbt Fusion writes a manifest
// without what failed to parse): its answers and its failures lead with the note while the mark is set,
// and drop it after a clean parse; a read-only call, a call with no adapter running and a manifest of
// another project carry none. The adapter is replaced through `dbtAdapterInternals`; the mark is
// recorded on it through dbt-tools' own recorder, the one its adapter's parse event feeds.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { Dispatcher } from "@/altimate/native"
import { dbtAdapterInternals, getDbtAdapter, resetDbtAdapter } from "@/altimate/native/connections/register"
import { DbtLineageTool, type ModelLineage } from "@/altimate/tools/dbt-lineage"
import { structuredResult } from "@/altimate/mcp-server/server"
import { recordPartialManifest } from "../../../dbt-tools/src/partial-manifest"
import { initTool } from "./tool-fixture"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_dbt_lineage_partial"),
  messageID: MessageID.make("msg_dbt_lineage_partial"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const CUSTOMERS = "model.jaffle_shop.customers"
const TRACE: ModelLineage = {
  version: 1,
  project: "jaffle_shop",
  dialect: "duckdb",
  focus: { uniqueId: CUSTOMERS, name: "customers" },
  nodes: [{ uniqueId: CUSTOMERS, name: "customers", type: "model", direction: "focus", depth: 0, parents: [], columns: [] }],
  columnLineage: [],
  confidence: "high",
  errors: [],
  stats: { nodes: 1, edges: 0 },
}
const MISSING_REF = "Ref 'stg_orderz' not found in project.\n  --> models/customers.sql:9:19"
const NOTE = "This graph is missing parts because models/customers.sql failed to parse."

let project: string
let other: string

/** The manifest answer, as `dbt.lineage` returns it. */
const manifestOnly = () =>
  spyOn(Dispatcher, "call").mockImplementation((async (method: string) => {
    if (method !== "dbt.lineage") throw new Error(`unexpected ${method}`)
    return { model_name: "customers", raw_lineage: {}, confidence: "low", confidence_factors: [] }
  }) as any)

/** Starts the fake adapter, as another tool's call would, and records its last parse. */
async function runningAdapter(partial: boolean, lineage?: () => Promise<unknown>) {
  dbtAdapterInternals.create = async () => ({
    isInitialized: () => true,
    dispose: async () => {},
    ...(lineage ? { getModelLineage: lineage } : {}),
  })
  const adapter = await getDbtAdapter()
  recordPartialManifest(
    adapter,
    (partial ? { partial: { errors: [{ filePath: path.join(project, "models", "customers.sql"), message: MISSING_REF }] } } : {}) as any,
  )
  return adapter
}

const lineage = async (args: Record<string, unknown>, context: Tool.Context = ctx) =>
  (await initTool(DbtLineageTool)).execute({ model: "customers", ...args }, context)

beforeAll(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "dbt-lineage-partial-"))
  await writeFile(path.join(project, "dbt_project.yml"), "name: jaffle_shop\n")
  await mkdir(path.join(project, "target"))
  await writeFile(path.join(project, "target", "manifest.json"), "{}")
  other = await mkdtemp(path.join(os.tmpdir(), "dbt-lineage-partial-other-"))
  await writeFile(path.join(other, "dbt_project.yml"), "name: other\n")
  await mkdir(path.join(other, "target"))
  await writeFile(path.join(other, "target", "manifest.json"), "{}")
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
  await rm(other, { recursive: true, force: true })
})

beforeEach(() => {
  resetDbtAdapter()
  dbtAdapterInternals.readConfig = async () => ({
    projectRoot: project,
    pythonPath: "python3",
    dbtIntegration: "fusion",
    queryLimit: 500,
  })
  // As with the dbt-integration released today: dbt_lineage itself answers from the manifest.
  dbtAdapterInternals.hasModelLineage = () => false
})

afterEach(() => {
  resetDbtAdapter()
  delete dbtAdapterInternals.readConfig
  delete dbtAdapterInternals.create
  delete dbtAdapterInternals.hasModelLineage
})

describe("dbt_lineage with the dbt adapter running", () => {
  test("a manifest answer leads with the note while the last parse had errors", async () => {
    await runningAdapter(true)
    const call = manifestOnly()
    try {
      const result = await lineage({})
      expect(result.output.split("\n").slice(0, 4)).toEqual([
        NOTE,
        "  models/customers.sql: Ref 'stg_orderz' not found in project.",
        "      --> models/customers.sql:9:19",
        "",
      ])
      expect(result.metadata.partial_manifest).toEqual({
        message: NOTE,
        errors: [{ file_path: "models/customers.sql", message: MISSING_REF }],
      })
    } finally {
      call.mockRestore()
    }
  })

  test("a failure leads with the note too", async () => {
    await runningAdapter(true)
    const call = spyOn(Dispatcher, "call").mockImplementation((async () => {
      throw new Error("manifest unreadable")
    }) as any)
    try {
      const result = await lineage({})
      expect(result.title).toBe("dbt Lineage: ERROR")
      expect(result.output.startsWith(`${NOTE}\n`)).toBe(true)
      expect(result.output).toContain("Failed: manifest unreadable")
      expect(result.metadata.partial_manifest?.message).toBe(NOTE)
    } finally {
      call.mockRestore()
    }
  })

  test("the adapter's own lineage leads with the note", async () => {
    dbtAdapterInternals.hasModelLineage = () => true
    await runningAdapter(true, async () => TRACE)
    const result = await lineage({})
    expect(result.metadata.structuredContent).toEqual(TRACE)
    expect(result.output.startsWith(`${NOTE}\n`)).toBe(true)
    expect(result.metadata.partial_manifest?.message).toBe(NOTE)
  })

  test("the note goes after a clean parse", async () => {
    const adapter = await runningAdapter(true)
    recordPartialManifest(adapter, {} as any)
    const call = manifestOnly()
    try {
      const result = await lineage({})
      expect(result.output).not.toContain("missing parts")
      expect(result.metadata.partial_manifest).toBeUndefined()
    } finally {
      call.mockRestore()
    }
  })

  test("a manifest of another dbt project carries no note", async () => {
    await runningAdapter(true)
    const call = manifestOnly()
    try {
      const result = await lineage({ manifest_path: path.join(other, "target", "manifest.json") })
      expect(result.output).not.toContain("missing parts")
      expect(result.metadata.partial_manifest).toBeUndefined()
    } finally {
      call.mockRestore()
    }
  })

  test("a read-only call carries no note", async () => {
    await runningAdapter(true)
    const call = manifestOnly()
    try {
      for (const context of [{ ...ctx, extra: { forceReadOnly: true } }, { ...ctx, agent: "plan" }]) {
        const result = await lineage({}, context)
        expect(result.output).not.toContain("missing parts")
        expect(result.metadata.partial_manifest).toBeUndefined()
      }
    } finally {
      call.mockRestore()
    }
  })
})

describe("dbt_lineage with no dbt adapter running", () => {
  test("carries no note and starts none", async () => {
    let created = 0
    dbtAdapterInternals.create = async () => {
      created += 1
      return { isInitialized: () => true, dispose: async () => {} }
    }
    const call = manifestOnly()
    try {
      const result = await lineage({})
      expect(created).toBe(0)
      expect(result.metadata.partial_manifest).toBeUndefined()
    } finally {
      call.mockRestore()
    }
  })
})

describe("the MCP server's structured result", () => {
  test("carries the note", async () => {
    await runningAdapter(true)
    const call = manifestOnly()
    try {
      const result = await lineage({})
      const structured = structuredResult("dbt_lineage", result.metadata, result.output)
      expect(structured.partial_manifest).toEqual(result.metadata.partial_manifest)
      expect(String(structured.report).startsWith(NOTE)).toBe(true)
    } finally {
      call.mockRestore()
    }
  })
})
