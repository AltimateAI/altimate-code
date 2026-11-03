// altimate_change - new file
//
// dbt_lineage returns dbt-integration's structured lineage when the project's dbt
// adapter is up, and the adapter prefers the Python-bridge mode for a project found
// without a dbt.json. The dbt adapter is replaced through `dbtAdapterInternals`, so
// these tests need no Python or dbt.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { Dispatcher } from "@/altimate/native"
import * as register from "@/altimate/native/connections/register"
import {
  dbtAdapterInternals,
  getDbtAdapter,
  getDbtProjectRoot,
  resetDbtAdapter,
} from "@/altimate/native/connections/register"
import { clearDbtLogs, getRecentDbtLogs } from "../../../dbt-tools/src/log-buffer"
import { DbtLineageTool, type ModelLineage } from "@/altimate/tools/dbt-lineage"
import { createServer } from "@/altimate/mcp-server/server"
import { initTool } from "./tool-fixture"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_dbt_lineage"),
  messageID: MessageID.make("msg_dbt_lineage"),
  agent: "analyst",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const id = (kind: string, name: string) => `${kind}.jaffle_shop.${name}`
const node = (
  kind: string,
  name: string,
  direction: ModelLineage["nodes"][number]["direction"],
  depth: number,
  parents: string[] = [],
  materialization = kind === "model" ? "table" : kind,
) => ({ uniqueId: id(kind, name), name, type: kind, materialization, direction, depth, parents, columns: [] })

const TRACE: ModelLineage = {
  version: 1,
  project: "jaffle_shop",
  dialect: "duckdb",
  focus: { uniqueId: id("model", "customers"), name: "customers", column: "customer_lifetime_value" },
  nodes: [
    node("source", "stripe.payments", "upstream", 2),
    node("model", "stg_payments", "upstream", 1, [id("source", "stripe.payments")], "view"),
    node("model", "customers", "focus", 0, [id("model", "stg_payments")]),
    node("model", "customer_segments", "downstream", 1, [id("model", "customers")]),
  ],
  columnLineage: [
    {
      source: [id("source", "stripe.payments"), "amount"],
      target: [id("model", "stg_payments"), "amount"],
      type: "direct",
      viewsType: "Not sure",
      viewsCode: [],
    },
    {
      source: [id("model", "stg_payments"), "amount"],
      target: [id("model", "customers"), "customer_lifetime_value"],
      type: "direct",
      viewsType: "Not sure",
      viewsCode: [],
    },
    {
      source: [id("model", "customers"), "customer_lifetime_value"],
      target: [id("model", "customer_segments"), "customer_lifetime_value"],
      type: "direct",
      viewsType: "Original",
      viewsCode: ["customers.customer_lifetime_value", "customer_lifetime_value"],
    },
  ],
  confidence: "high",
  errors: [],
  stats: { nodes: 4, edges: 3 },
}

let project: string
const requests: unknown[] = []

function fakeAdapter(initialized: boolean, lineage?: (params: { model: string; column?: string }) => Promise<unknown>) {
  return {
    isInitialized: () => initialized,
    dispose: async () => {},
    ...(lineage ? { getModelLineage: lineage } : {}),
  }
}

function useConfig(autoDiscovered: boolean, dbtIntegration = "corecommand", projectRoot = project) {
  dbtAdapterInternals.readConfig = async () => ({
    projectRoot,
    pythonPath: "python3",
    dbtIntegration,
    queryLimit: 500,
    autoDiscovered,
  })
}

beforeAll(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "dbt-lineage-structured-"))
  await writeFile(path.join(project, "dbt_project.yml"), "name: jaffle_shop\n")
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

beforeEach(() => {
  resetDbtAdapter()
  requests.length = 0
})

afterEach(() => {
  resetDbtAdapter()
  delete dbtAdapterInternals.readConfig
  delete dbtAdapterInternals.create
  delete dbtAdapterInternals.noUserSql
})

describe("dbt_lineage with the project's dbt adapter", () => {
  beforeEach(() => {
    useConfig(false)
    dbtAdapterInternals.create = async () =>
      fakeAdapter(true, async (params) => {
        requests.push(params)
        return TRACE
      })
  })

  test("returns dbt-integration's result as structured content, with a readable text", async () => {
    const tool = await initTool(DbtLineageTool)
    const result = await tool.execute({ model: "customers", column: "customer_lifetime_value" }, ctx)
    expect(requests).toEqual([{ model: "customers", column: "customer_lifetime_value" }])
    expect(result.metadata.structuredContent).toEqual(TRACE)
    expect(result.title).toBe("dbt Lineage: customers.customer_lifetime_value [high]")
    expect(result.output).toContain("Upstream (2):")
    expect(result.output).toContain("Trace of customers.customer_lifetime_value (3 edges):")
    expect(result.output).toContain(
      "customer_segments.customer_lifetime_value ← customers.customer_lifetime_value  [direct, Original] = customer_lifetime_value",
    )
    // Upstream hops first, then the focus, then downstream.
    const order = ["stg_payments.amount ←", "customers.customer_lifetime_value ←", "customer_segments."]
    const at = order.map((line) => result.output.indexOf(line))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  test("a manifest named outside the adapter's project wins over the adapter", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dbt-lineage-project-"))
    const mine = path.join(dir, "mine")
    const other = path.join(dir, "other")
    await Promise.all([mine, other].map((d) => mkdir(path.join(d, "target"), { recursive: true })))
    const empty = JSON.stringify({ metadata: { adapter_type: "duckdb" }, nodes: {}, sources: {} })
    await writeFile(path.join(mine, "dbt_project.yml"), "name: mine\n")
    await writeFile(path.join(mine, "target", "manifest.json"), empty)
    await writeFile(path.join(other, "target", "manifest.json"), empty)
    // The adapter itself is configured with `mine`, so the tool reads the root the adapter cached.
    resetDbtAdapter()
    useConfig(false, "corecommand", mine)
    try {
      const tool = await initTool(DbtLineageTool)
      const fallback = await tool.execute({ model: "customers", manifest_path: path.join(other, "target", "manifest.json") }, ctx)
      expect(fallback.metadata.structuredContent).toBeUndefined()
      expect(fallback.output).toContain(`is not in the dbt project at ${mine}`)
      const kept = await tool.execute({ model: "customers", manifest_path: path.join(mine, "target", "manifest.json") }, ctx)
      expect(kept.metadata.structuredContent).toEqual(TRACE)
      // A dbt project nested in this one's folder is another project.
      const nested = path.join(mine, "subproject")
      await mkdir(path.join(nested, "target"), { recursive: true })
      await writeFile(path.join(nested, "dbt_project.yml"), "name: sub\n")
      await writeFile(path.join(nested, "target", "manifest.json"), empty)
      const inner = await tool.execute({ model: "customers", manifest_path: path.join(nested, "target", "manifest.json") }, ctx)
      expect(inner.metadata.structuredContent).toBeUndefined()
      expect(inner.output).toContain("belongs to the dbt project at")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("include_graph with no manifest to read says so in graph_error", async () => {
    const tool = await initTool(DbtLineageTool)
    const result = await tool.execute({ model: "customers", include_graph: true }, ctx)
    expect(result.metadata.structuredContent).toEqual(TRACE)
    expect(result.metadata.graph).toBeUndefined()
    expect(result.metadata.graph_error).toBe(`no manifest at ${path.join(project, "target", "manifest.json")}`)
  })

  test("is handed to an MCP client as structuredContent", async () => {
    const server = await createServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(clientTransport)
    try {
      const answer = await client.callTool({
        name: "dbt_lineage",
        arguments: { model: "customers", column: "customer_lifetime_value" },
      })
      expect(answer.isError).toBe(false)
      // The MCP server adds the text report beside the trace (clients may show structured content in place of the text).
      expect(answer.structuredContent).toEqual({ ...TRACE, report: expect.any(String) })
      expect((answer.content as { text: string }[])[0].text).toContain("Trace of customers.customer_lifetime_value")
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe("dbt_lineage without dbt-integration's lineage", () => {
  const manifestOnly = () =>
    spyOn(Dispatcher, "call").mockImplementation((async () => ({
      model_name: "customers",
      raw_lineage: {},
      confidence: "low",
      confidence_factors: [],
    })) as any)

  test("falls back to the manifest when there is no dbt project", async () => {
    dbtAdapterInternals.readConfig = async () => null
    const call = manifestOnly()
    try {
      const tool = await initTool(DbtLineageTool)
      const result = await tool.execute({ model: "customers" }, ctx)
      expect(call).toHaveBeenCalledWith("dbt.lineage", {
        manifest_path: path.join("target", "manifest.json"),
        model: "customers",
        dialect: undefined,
      })
      expect(result.metadata.structuredContent).toBeUndefined()
      expect(result.output).toContain("dbt integration not used: no dbt project here")
    } finally {
      call.mockRestore()
    }
  })

  test("falls back when the dbt-integration in use has no getModelLineage", async () => {
    useConfig(false)
    dbtAdapterInternals.create = async () => fakeAdapter(true)
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expect(result.output).toContain("dbt integration not used: dbt-integration has no getModelLineage")
    } finally {
      call.mockRestore()
    }
  })

  test("falls back when the adapter didn't load the project", async () => {
    useConfig(false)
    dbtAdapterInternals.create = async () =>
      fakeAdapter(false, async () => {
        throw new Error("No manifest has been generated")
      })
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expect(result.output).toContain("dbt integration not used: the dbt adapter didn't load the project")
    } finally {
      call.mockRestore()
    }
  })

  test("reads the manifest of the project the adapter found, not the working directory's", async () => {
    useConfig(false)
    dbtAdapterInternals.create = async () => fakeAdapter(true)
    const call = manifestOnly()
    try {
      await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expect(call.mock.calls[0]?.[1]).toMatchObject({ manifest_path: path.join(project, "target", "manifest.json") })
    } finally {
      call.mockRestore()
    }
  })

  test("falls back with the reason when a dbt.json's project root isn't a path", async () => {
    dbtAdapterInternals.readConfig = async () => ({ projectRoot: 123 })
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expect(call.mock.calls[0]?.[1]).toMatchObject({ manifest_path: path.join("target", "manifest.json") })
      expect(result.output).toContain("dbt integration not used: no dbt project here")
    } finally {
      call.mockRestore()
    }
  })

  test("says a column trace fell back to the whole model", async () => {
    dbtAdapterInternals.readConfig = async () => null
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers", column: "id" }, ctx)
      expect(result.output).toContain("tracing id needs the dbt integration; this is the whole model's lineage")
    } finally {
      call.mockRestore()
    }
  })

  test("keeps the adapter's reason when the manifest fallback fails too", async () => {
    dbtAdapterInternals.readConfig = async () => null
    const call = spyOn(Dispatcher, "call").mockImplementation((async () => {
      throw new Error("Manifest file not found")
    }) as any)
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expect(result.output).toContain("Failed: Manifest file not found")
      expect(result.output).toContain("dbt integration not used: no dbt project here")
    } finally {
      call.mockRestore()
    }
  })

  test("stops on a cancelled call, without the manifest fallback", async () => {
    useConfig(false)
    const controller = new AbortController()
    dbtAdapterInternals.create = async () =>
      fakeAdapter(true, async () => {
        controller.abort()
        throw new DOMException("This operation was aborted", "AbortError")
      })
    const call = manifestOnly()
    try {
      const tool = await initTool(DbtLineageTool)
      await expect(tool.execute({ model: "customers" }, { ...ctx, abort: controller.signal })).rejects.toThrow(
        "aborted",
      )
      expect(call).not.toHaveBeenCalled()
    } finally {
      call.mockRestore()
    }
  })

  test("stops on a call cancelled while the fallback looks for the manifest", async () => {
    const controller = new AbortController()
    useConfig(false)
    dbtAdapterInternals.create = async () =>
      fakeAdapter(true, async () => {
        throw new Error("lookup failed")
      })
    const root = spyOn(register, "getDbtProjectRoot").mockImplementation(async () => {
      controller.abort()
      return project
    })
    const call = manifestOnly()
    try {
      const tool = await initTool(DbtLineageTool)
      await expect(tool.execute({ model: "customers" }, { ...ctx, abort: controller.signal })).rejects.toThrow()
      expect(root).toHaveBeenCalled()
      expect(call).not.toHaveBeenCalled()
    } finally {
      root.mockRestore()
      call.mockRestore()
    }
  })

  test("stops on a call cancelled while the adapter is still starting", async () => {
    useConfig(false)
    const controller = new AbortController()
    dbtAdapterInternals.create = () => new Promise(() => {})
    const call = manifestOnly()
    try {
      const tool = await initTool(DbtLineageTool)
      const running = tool.execute({ model: "customers" }, { ...ctx, abort: controller.signal })
      setTimeout(() => controller.abort(), 10)
      // Bounded here: a call that waits for the adapter never settles.
      const outcome = await Promise.race([
        running.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1000)),
      ])
      expect(outcome).toBe("rejected")
      expect(call).not.toHaveBeenCalled()
    } finally {
      call.mockRestore()
    }
  })

  test("reuses the project root the adapter attempt read", async () => {
    let reads = 0
    dbtAdapterInternals.readConfig = async () => {
      reads += 1
      return { projectRoot: project, pythonPath: "python3", dbtIntegration: "corecommand", queryLimit: 500 }
    }
    dbtAdapterInternals.create = async () => fakeAdapter(true)
    const call = manifestOnly()
    try {
      await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expect(call.mock.calls[0]?.[1]).toMatchObject({ manifest_path: path.join(project, "target", "manifest.json") })
      expect(reads).toBe(1)
    } finally {
      call.mockRestore()
    }
  })

  test("falls back with the reason when the lookup fails", async () => {
    useConfig(false)
    dbtAdapterInternals.create = async () =>
      fakeAdapter(true, async () => {
        throw new Error("Model 'nope' is not in the project's manifest")
      })
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "nope" }, ctx)
      expect(result.metadata.structuredContent).toBeUndefined()
      expect(result.output).toContain("Model 'nope' is not in the project's manifest")
    } finally {
      call.mockRestore()
    }
  })
})

describe("the dbt adapter's integration mode", () => {
  const tried: string[] = []
  const creating = (initialized: Record<string, boolean | "throws">) => async (config: { dbtIntegration: string }) => {
    tried.push(config.dbtIntegration)
    if (initialized[config.dbtIntegration] === "throws") throw new Error("bridge could not start")
    return { mode: config.dbtIntegration, ...fakeAdapter(initialized[config.dbtIntegration] === true) }
  }
  beforeEach(() => {
    tried.length = 0
    dbtAdapterInternals.noUserSql = true
  })

  test("a project found without a dbt.json uses the Python bridge when it brings the project up", async () => {
    useConfig(true)
    dbtAdapterInternals.create = creating({ core: true })
    expect(await getDbtAdapter()).toMatchObject({ mode: "core" })
    expect(tried).toEqual(["core"])
  })

  test("it falls back to the configured mode when the bridge doesn't", async () => {
    useConfig(true)
    dbtAdapterInternals.create = creating({ core: false, corecommand: true })
    expect(await getDbtAdapter()).toMatchObject({ mode: "corecommand" })
    expect(tried).toEqual(["core", "corecommand"])
  })

  test("it falls back when the bridge can't start at all, and logs why", async () => {
    clearDbtLogs()
    useConfig(true)
    dbtAdapterInternals.create = creating({ core: "throws", corecommand: true })
    expect(await getDbtAdapter()).toMatchObject({ mode: "corecommand" })
    expect(tried).toEqual(["core", "corecommand"])
    expect(getRecentDbtLogs()).toContain("Python bridge did not start, using corecommand: bridge could not start")
  })

  test("user SQL never runs on the bridge chosen for a read-only process", async () => {
    useConfig(true)
    const ran: string[] = []
    dbtAdapterInternals.create = async (config: { dbtIntegration: string }) => ({
      ...fakeAdapter(true),
      immediatelyExecuteSQL: async (sql: string) => {
        ran.push(sql)
        return { columnNames: ["n"], data: [{ n: 1 }] }
      },
      mode: config.dbtIntegration,
    })
    const bridge = await getDbtAdapter()
    expect(bridge).toMatchObject({ mode: "core" })
    // Even after the cache is reset, the bridge adapter itself is refused.
    resetDbtAdapter()
    dbtAdapterInternals.create = async () => bridge
    useConfig(false)
    // Whatever the native route answers, the bridge doesn't run the statement.
    await Dispatcher.call("sql.execute", { sql: "create table t as select 1 as n" }).catch(() => {})
    expect(ran).toEqual([])
  })

  test("a process that can run user SQL through dbt keeps the configured mode", async () => {
    delete dbtAdapterInternals.noUserSql
    useConfig(true)
    dbtAdapterInternals.create = creating({ core: true, corecommand: true })
    expect(await getDbtAdapter()).toMatchObject({ mode: "corecommand" })
    expect(tried).toEqual(["corecommand"])
  })

  test("a dbt.json's mode is used as configured", async () => {
    useConfig(false)
    dbtAdapterInternals.create = creating({ core: true, corecommand: true })
    expect(await getDbtAdapter()).toMatchObject({ mode: "corecommand" })
    expect(tried).toEqual(["corecommand"])
  })
})
