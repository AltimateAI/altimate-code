// The tools the dbt Power User features call: their allow-list entries and placeholder answers, the
// one gate every dbt-adapter-backed tool goes through, and the API helper for new endpoint files. The
// dbt adapter is replaced through `dbtAdapterInternals`, so these tests need no Python or dbt.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { dbtAdapterInternals, resetDbtAdapter } from "@/altimate/native/connections/register"
import { dbtAdapterAccessInternals, dbtAdapterFor } from "@/altimate/tools/dbt-adapter-access"
import { EXPOSED, MCP_OPEN_WRITE_TOOLS, WRITE_TOOLS } from "@/altimate/tool-cli/allow-list"
import { AltimateApi } from "@/altimate/api/client"
import { Instance } from "@/project/instance"
import { disposeInstance } from "@/effect/instance-registry"
import { initTool } from "./tool-fixture"

/** Each tool with the smallest arguments its parameters accept. */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  dbt_run_results: {},
  dbt_defer_state: { project_dir: "." },
  dbt_map_relations: { sql: "select 1" },
  docs_share_comments: { action: "list" },
  dbt_cost_estimate: {},
  dbt_health: {},
  dbt_sql_graph: { model: "customers" },
  dbt_docs_coverage: { model: "customers" },
  dbt_cte_profile: { model: "customers" },
}
const FEATURE_TOOLS = Object.keys(MINIMAL_ARGS)
/** Tools that have their own implementation and tests. */
const IMPLEMENTED = new Set(["dbt_health"])

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_dbt_adapter_access"),
  messageID: MessageID.make("msg_dbt_adapter_access"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

let project: string

function useConfig() {
  dbtAdapterInternals.readConfig = async () => ({
    projectRoot: project,
    pythonPath: "python3",
    dbtIntegration: "corecommand",
    queryLimit: 500,
  })
}

beforeAll(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "dbt-adapter-access-"))
  await writeFile(path.join(project, "dbt_project.yml"), "name: jaffle_shop\n")
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

beforeEach(() => resetDbtAdapter())

afterEach(() => {
  resetDbtAdapter()
  delete dbtAdapterInternals.readConfig
  delete dbtAdapterInternals.create
})

describe("feature tools in the allow-list", () => {
  test("all nine are exposed, in the map's alphabetical order, and none is a write tool", () => {
    const ids = Object.keys(EXPOSED)
    for (const id of FEATURE_TOOLS) {
      expect(ids).toContain(id)
      expect(WRITE_TOOLS.has(id)).toBe(false)
      expect(MCP_OPEN_WRITE_TOOLS.has(id)).toBe(false)
    }
    const listed = ids.filter((id) => id.startsWith("dbt_") || id.startsWith("docs_"))
    expect(listed).toEqual([...listed].sort())
  })

  test("each placeholder answers that it isn't implemented, as a failure", async () => {
    for (const id of FEATURE_TOOLS.filter((id) => !IMPLEMENTED.has(id))) {
      const tool = await initTool(EXPOSED[id] as any)
      expect(tool.id).toBe(id)
      const result = await tool.execute(MINIMAL_ARGS[id], ctx)
      expect(result.title).toBe(`${id}: not implemented`)
      expect(result.metadata.success).toBe(false)
      expect(result.output).toContain(id)
    }
  })
})

describe("dbtAdapterFor", () => {
  let created: number
  beforeEach(() => {
    created = 0
    useConfig()
    dbtAdapterInternals.create = async () => {
      created += 1
      return { isInitialized: () => true, dispose: async () => {} }
    }
  })

  test("refuses a read-only call and never creates the adapter", async () => {
    const access = await dbtAdapterFor({ ...ctx, extra: { forceReadOnly: true } })
    expect(access.adapter).toBeUndefined()
    expect(access.refusal).toBe("read_only")
    expect(access.reason).toContain("--allow-write")
    expect(created).toBe(0)
  })

  test("refuses a plan-mode call", async () => {
    const access = await dbtAdapterFor({ ...ctx, agent: "plan" })
    expect(access.refusal).toBe("read_only")
    expect(created).toBe(0)
  })

  test("returns the adapter where writes are allowed", async () => {
    const access = await dbtAdapterFor(ctx)
    expect(access.refusal).toBeUndefined()
    expect(access.adapter?.isInitialized()).toBe(true)
    expect(created).toBe(1)
  })

  test("says when the adapter didn't load the project", async () => {
    dbtAdapterInternals.create = async () => ({ isInitialized: () => false, dispose: async () => {} })
    const access = await dbtAdapterFor(ctx)
    expect(access).toEqual({ refusal: "not_loaded", reason: "the dbt adapter didn't load the project" })
  })

  test("says there is no dbt project when the config finds none", async () => {
    dbtAdapterInternals.readConfig = async () => null
    const access = await dbtAdapterFor(ctx)
    expect(access).toEqual({ refusal: "no_project", reason: "no dbt project here" })
  })

  test("says when the adapter doesn't start in time", async () => {
    dbtAdapterInternals.create = () => new Promise(() => {})
    const saved = dbtAdapterAccessInternals.adapterStartTimeoutMs
    dbtAdapterAccessInternals.adapterStartTimeoutMs = 20
    try {
      const access = await dbtAdapterFor(ctx)
      expect(access).toEqual({ refusal: "not_started", reason: "the dbt adapter didn't start within 0.02 s" })
    } finally {
      dbtAdapterAccessInternals.adapterStartTimeoutMs = saved
    }
  })

  test("a cancelled call throws rather than answering", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(dbtAdapterFor({ ...ctx, abort: controller.signal })).rejects.toThrow()
    expect(created).toBe(0)
  })

  test("a session in a dbt project the adapter isn't set up for says so", async () => {
    dbtAdapterInternals.readConfig = async () => null
    try {
      const access = await Instance.provide({ directory: project, fn: () => dbtAdapterFor(ctx) })
      expect(access).toEqual({
        refusal: "other_project",
        reason: `the dbt adapter isn't set up for ${realpathSync(project)}`,
      })
      expect(created).toBe(0)
    } finally {
      await disposeInstance(project)
    }
  })
})

describe("AltimateApi.apiRequest", () => {
  let home: string
  let saved: string | undefined
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "altimate-api-home-"))
    saved = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home
  })
  afterEach(async () => {
    if (saved === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = saved
    await rm(home, { recursive: true, force: true })
  })

  test("fails with a clear message when no credentials are stored", async () => {
    await expect(AltimateApi.apiRequest("GET", "/dbt/v1/x")).rejects.toThrow(
      `No Altimate credentials are stored: sign in to Altimate in altimate-code first (they are saved to ${path.join(home, ".altimate", "altimate.json")}).`,
    )
  })

  test("sends the stored key and tenant and returns the JSON body", async () => {
    await Bun.write(
      path.join(home, ".altimate", "altimate.json"),
      JSON.stringify({ altimateUrl: "https://api.example.test/", altimateInstanceName: "acme", altimateApiKey: "k1" }),
    )
    const original = globalThis.fetch
    const seen: { url: string; init: RequestInit }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      expect(await AltimateApi.apiRequest("POST", "/dbt/v1/x", { a: 1 })).toEqual({ ok: 1 })
      expect(seen[0].url).toBe("https://api.example.test/dbt/v1/x")
      const headers = seen[0].init.headers as Record<string, string>
      expect(headers.Authorization).toBe("Bearer k1")
      expect(headers["x-tenant"]).toBe("acme")
      expect(seen[0].init.body).toBe(JSON.stringify({ a: 1 }))
    } finally {
      globalThis.fetch = original
    }
  })

  test("names the file when the stored credentials can't be read", async () => {
    await Bun.write(path.join(home, ".altimate", "altimate.json"), "{not json")
    await expect(AltimateApi.apiRequest("GET", "/dbt/v1/x")).rejects.toThrow("can't be used")
  })
})
