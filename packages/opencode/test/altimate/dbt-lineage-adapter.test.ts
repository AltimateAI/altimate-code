// altimate_change - new file
//
// dbt_lineage's use of the dbt adapter: a read-only call never starts or uses it, the wait for it
// is bounded and cancellable, and its result is shape-checked. Also the adapter sql_execute gets,
// and its disposal. The dbt adapter is replaced through `dbtAdapterInternals`, so these tests need
// no Python or dbt.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Tool } from "@/tool/tool"
import { SessionID, MessageID } from "@/session/schema"
import { Dispatcher } from "@/altimate/native"
import {
  dbtAdapterInternals,
  disposeDbtAdapter,
  getDbtAdapter,
  resetDbtAdapter,
} from "@/altimate/native/connections/register"
import { DbtLineageTool, dbtLineageInternals, type ModelLineage } from "@/altimate/tools/dbt-lineage"
import { createServer, serveStdio } from "@/altimate/mcp-server/server"
import * as Registry from "@/altimate/native/connections/registry"
import { initTool } from "./tool-fixture"
import { Instance } from "@/project/instance"
import { disposeInstance } from "@/effect/instance-registry"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_dbt_lineage_adapter"),
  messageID: MessageID.make("msg_dbt_lineage_adapter"),
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
  nodes: [
    { uniqueId: CUSTOMERS, name: "customers", type: "model", direction: "focus", depth: 0, parents: [], columns: [] },
  ],
  columnLineage: [],
  confidence: "high",
  errors: [],
  stats: { nodes: 1, edges: 0 },
}

let project: string

function fakeAdapter(initialized: boolean, lineage?: (params: unknown) => Promise<unknown>) {
  return {
    isInitialized: () => initialized,
    dispose: async () => {},
    ...(lineage ? { getModelLineage: lineage } : {}),
  }
}

/** What dbt-tools reads for a project found without a dbt.json. */
function useConfig() {
  dbtAdapterInternals.readConfig = async () => ({
    projectRoot: project,
    pythonPath: "python3",
    dbtIntegration: "corecommand",
    queryLimit: 500,
  })
}

/** The manifest answer, as main's `dbt.lineage` returns it. */
const manifestOnly = () =>
  spyOn(Dispatcher, "call").mockImplementation((async (method: string) => {
    if (method !== "dbt.lineage") throw new Error(`unexpected ${method}`)
    return { model_name: "customers", raw_lineage: {}, confidence: "low", confidence_factors: [] }
  }) as any)

/** A call made without write permission, as the MCP server and `tool run` make it. */
const readOnly = () => ({ ...ctx, extra: { ...ctx.extra, forceReadOnly: true } })

beforeAll(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "dbt-lineage-adapter-"))
  await writeFile(path.join(project, "dbt_project.yml"), "name: jaffle_shop\n")
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

beforeEach(() => {
  resetDbtAdapter()
})

afterEach(() => {
  resetDbtAdapter()
  delete dbtAdapterInternals.readConfig
  delete dbtAdapterInternals.create
})

describe("dbt_lineage in a read-only call", () => {
  let created: string[]
  let ran: string[]
  beforeEach(() => {
    created = []
    ran = []
    useConfig()
    const run = async (sql: string) => {
      ran.push(sql)
      return { columnNames: ["n"], columnTypes: ["integer"], data: [{ n: 1 }] }
    }
    dbtAdapterInternals.create = async (config: { dbtIntegration: string }) => {
      created.push(config.dbtIntegration)
      return {
        ...fakeAdapter(true, async () => TRACE),
        immediatelyExecuteSQL: run,
        immediatelyExecuteSQLWithLimit: run,
      }
    }
  })

  test("answers from the manifest with no note, and never creates the dbt adapter", async () => {
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, readOnly())
      expect(created).toEqual([])
      expect(call.mock.calls.map(([method]) => method)).toEqual(["dbt.lineage"])
      expect(result.metadata.structuredContent).toBeUndefined()
      expect(result.output).not.toContain("dbt integration not used")
    } finally {
      call.mockRestore()
    }
  })

  test("in plan mode, answers from the manifest and never creates the dbt adapter", async () => {
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, { ...ctx, agent: "plan" })
      expect(created).toEqual([])
      expect(call.mock.calls.map(([method]) => method)).toEqual(["dbt.lineage"])
      expect(result.output).not.toContain("dbt integration not used")
    } finally {
      call.mockRestore()
    }
  })

  test("ignores a dbt adapter another tool already started", async () => {
    const lookups: unknown[] = []
    dbtAdapterInternals.create = async () =>
      fakeAdapter(true, async (params) => {
        lookups.push(params)
        return TRACE
      })
    expect(await getDbtAdapter()).toBeTruthy()
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, readOnly())
      expect(lookups).toEqual([])
      expect(result.output).not.toContain("dbt integration not used")
    } finally {
      call.mockRestore()
    }
  })

  test("in a read-only MCP server, dbt_lineage starts no adapter and sql_execute runs nothing through dbt", async () => {
    const call = manifestOnly()
    const server = await createServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0" })
    await client.connect(clientTransport)
    try {
      const answer = await client.callTool({ name: "dbt_lineage", arguments: { model: "customers" } })
      expect(answer.isError).toBe(false)
      expect((answer.content as { text: string }[])[0].text).not.toContain("dbt integration not used")
      expect(created).toEqual([])
      call.mockRestore()
      // A read passes the permission check, so this reaches sql_execute's dbt routing.
      await client.callTool({ name: "sql_execute", arguments: { query: "select 1 as n" } })
      expect(ran).toEqual([])
    } finally {
      call.mockRestore()
      await client.close()
      await server.close()
    }
  })
})

describe("dbt_lineage's wait for the dbt adapter", () => {
  test("an already-cancelled call starts nothing", async () => {
    useConfig()
    let created = 0
    dbtAdapterInternals.create = async () => {
      created += 1
      return fakeAdapter(true, async () => TRACE)
    }
    const call = manifestOnly()
    const controller = new AbortController()
    controller.abort()
    try {
      const tool = await initTool(DbtLineageTool)
      await expect(tool.execute({ model: "customers" }, { ...ctx, abort: controller.signal })).rejects.toThrow()
      expect(created).toBe(0)
      expect(call).not.toHaveBeenCalled()
    } finally {
      call.mockRestore()
    }
  })

  test("a call cancelled while the tool loads its modules starts nothing", async () => {
    useConfig()
    let created = 0
    dbtAdapterInternals.create = async () => {
      created += 1
      return fakeAdapter(true, async () => TRACE)
    }
    const call = manifestOnly()
    const controller = new AbortController()
    try {
      const tool = await initTool(DbtLineageTool)
      // execute runs up to its first await (the module imports) before this abort.
      const running = tool.execute({ model: "customers" }, { ...ctx, abort: controller.signal })
      controller.abort()
      await expect(running).rejects.toThrow()
      expect(created).toBe(0)
      expect(call).not.toHaveBeenCalled()
    } finally {
      call.mockRestore()
    }
  })

  test("a call cancelled while it reads which project the session is in starts nothing", async () => {
    const controller = new AbortController()
    dbtAdapterInternals.readConfig = async () => {
      controller.abort()
      return { projectRoot: project, pythonPath: "python3", dbtIntegration: "corecommand", queryLimit: 500 }
    }
    let created = 0
    dbtAdapterInternals.create = async () => {
      created += 1
      return fakeAdapter(true, async () => TRACE)
    }
    const call = manifestOnly()
    try {
      const running = Instance.provide({
        directory: project,
        fn: async () => (await initTool(DbtLineageTool)).execute({ model: "customers" }, { ...ctx, abort: controller.signal }),
      })
      await expect(running).rejects.toThrow()
      expect(created).toBe(0)
      expect(call).not.toHaveBeenCalled()
    } finally {
      call.mockRestore()
      await disposeInstance(project)
    }
  })

  test("a session in a dbt project the adapter finds none for says so, not 'no dbt project here'", async () => {
    dbtAdapterInternals.readConfig = async () => null
    const call = manifestOnly()
    try {
      const result = await Instance.provide({
        directory: project,
        fn: async () => (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx),
      })
      expect(result.output).toContain(`dbt integration not used: the dbt adapter isn't set up for ${realpathSync(project)}`)
    } finally {
      call.mockRestore()
      await disposeInstance(project)
    }
  })

  test("doesn't answer with a lookup that finishes after the call was cancelled", async () => {
    useConfig()
    const controller = new AbortController()
    dbtAdapterInternals.create = async () =>
      fakeAdapter(true, async () => {
        controller.abort()
        return TRACE
      })
    const call = manifestOnly()
    try {
      const tool = await initTool(DbtLineageTool)
      await expect(tool.execute({ model: "customers" }, { ...ctx, abort: controller.signal })).rejects.toThrow()
      expect(call).not.toHaveBeenCalled()
    } finally {
      call.mockRestore()
    }
  })

  test("answers from the manifest when the adapter doesn't start in time", async () => {
    useConfig()
    dbtAdapterInternals.create = () => new Promise(() => {})
    const saved = dbtLineageInternals.adapterStartTimeoutMs
    dbtLineageInternals.adapterStartTimeoutMs = 20
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expect(result.output).toContain("dbt integration not used: the dbt adapter didn't start within 0.02 s")
      expect(call).toHaveBeenCalled()
    } finally {
      dbtLineageInternals.adapterStartTimeoutMs = saved
      call.mockRestore()
    }
  })

  test("says the adapter didn't start, not that there is no project, when its creation fails", async () => {
    useConfig()
    dbtAdapterInternals.create = async () => {
      throw new Error("Cannot access invalid private field")
    }
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expect(result.output).toContain("dbt integration not used: the dbt adapter didn't start\n")
      expect(result.output).not.toContain("no dbt project here")
      expect(call).toHaveBeenCalled()
    } finally {
      call.mockRestore()
    }
  })

  test("relays a lineage whose nodes reach the 3 hops it asked for", async () => {
    useConfig()
    const far = { ...TRACE.nodes[0]!, uniqueId: "model.jaffle_shop.far", name: "far", direction: "upstream" as const, depth: 3 }
    const lineage = { ...TRACE, nodes: [...TRACE.nodes, far] }
    dbtAdapterInternals.create = async () => fakeAdapter(true, async () => lineage)
    const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
    expect(result.metadata.structuredContent).toEqual(lineage)
  })

  test("falls back when the adapter returns a lineage it can't read", async () => {
    useConfig()
    const { confidence: _c, stats: _s, ...partial } = TRACE
    const node = TRACE.nodes[0]!
    const edge = {
      source: [node.uniqueId, "id"],
      target: [node.uniqueId, "id"],
      type: "direct",
      viewsType: "Transformation",
      viewsCode: ["id"],
    }
    const nested = [
      { ...TRACE, nodes: [{ ...node, columns: [null] }] },
      { ...TRACE, nodes: [{ ...node, name: undefined }] },
      { ...TRACE, nodes: [{ ...node, depth: "1" }] },
      { ...TRACE, nodes: [{ ...node, direction: "sideways" }] },
      { ...TRACE, columnLineage: [{ ...edge, source: [] }] },
      { ...TRACE, columnLineage: [{ ...edge, target: [null, null] }] },
      { ...TRACE, columnLineage: [{ ...edge, viewsCode: [1] }] },
      { ...TRACE, errors: [null] },
      { ...TRACE, focus: { ...TRACE.focus, column: 1 } },
      { ...TRACE, nodes: [{ ...node, materialization: 1 }] },
      { ...TRACE, nodes: [{ ...node, parents: undefined }] },
      { ...TRACE, nodes: [{ ...node, parents: [1] }] },
      { ...TRACE, nodes: [{ ...node, columns: [{ name: "id", dataType: 1 }] }] },
      { ...TRACE, nodes: [{ ...node, columns: [{ name: "id", isDocumentedOnly: "yes" }] }] },
      { ...TRACE, stats: [] },
      { ...TRACE, stats: { nodes: "3" } },
      { ...TRACE, stats: { nodes: Number.NaN } },
      { ...TRACE, nodes: [{ ...node, depth: Number.POSITIVE_INFINITY }] },
      { ...TRACE, nodes: [{ ...node, depth: 1e9 }] },
      { ...TRACE, nodes: [{ ...node, depth: -1 }] },
      { ...TRACE, nodes: [{ ...node, depth: 1.5 }] },
    ]
    for (const unreadable of [{ version: 1, nodes: "?" }, partial, { ...TRACE, version: 2 }, ...nested]) {
      resetDbtAdapter()
      dbtAdapterInternals.create = async () => fakeAdapter(true, async () => unreadable)
      const call = manifestOnly()
      try {
        const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
        expect(result.output).toContain(
          "dbt integration not used: dbt-integration returned a lineage this tool can't read",
        )
      } finally {
        call.mockRestore()
      }
    }
  })
})

describe("the dbt adapter sql_execute uses", () => {
  test("a project without a dbt.json gets the configured mode, and sql_execute runs through it", async () => {
    useConfig()
    const created: string[] = []
    const ran: string[] = []
    dbtAdapterInternals.create = async (config: { dbtIntegration: string }) => {
      created.push(config.dbtIntegration)
      return {
        ...fakeAdapter(true),
        immediatelyExecuteSQL: async (sql: string) => {
          ran.push(sql)
          return { columnNames: ["n"], columnTypes: ["integer"], data: [{ n: 1 }] }
        },
      }
    }
    await Dispatcher.call("sql.execute", { sql: "select 1 as n" }).catch(() => {})
    expect(created).toEqual(["corecommand"])
    expect(ran).toEqual(["select 1 as n"])
  })

  test("is disposed on shutdown, also one still starting", async () => {
    useConfig()
    let disposed = 0
    const adapter = { ...fakeAdapter(true), dispose: async () => void (disposed += 1) }
    dbtAdapterInternals.create = async () => adapter
    expect(await getDbtAdapter()).toBe(adapter)
    await disposeDbtAdapter()
    expect(disposed).toBe(1)

    let finish!: (value: unknown) => void
    dbtAdapterInternals.create = () => new Promise((resolve) => (finish = resolve))
    const starting = getDbtAdapter()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await disposeDbtAdapter()
    finish(adapter)
    await starting
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(disposed).toBe(2)
  })

  test("is disposed when the stdio server closes, even if closing the warehouses fails", async () => {
    useConfig()
    let disposed = 0
    dbtAdapterInternals.create = async () => ({ ...fakeAdapter(true), dispose: async () => void (disposed += 1) })
    await getDbtAdapter()
    const closeAll = spyOn(Registry, "closeAll").mockImplementation(async () => {
      throw new Error("close failed")
    })
    const consoleMethods = { log: console.log, info: console.info, debug: console.debug }
    try {
      // Settled into a value at once: the server may close before this test ends stdin itself.
      const serving = serveStdio().then(
        () => undefined,
        (error: unknown) => error,
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      process.stdin.emit("end")
      expect(((await serving) as Error | undefined)?.message).toBe("close failed")
      expect(disposed).toBe(1)
    } finally {
      closeAll.mockRestore()
      Object.assign(console, consoleMethods)
    }
  })
})
