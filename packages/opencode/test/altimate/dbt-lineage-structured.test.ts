// altimate_change - new file
//
// dbt_lineage returns dbt-integration's structured lineage when the project's dbt
// adapter is up and the call may write. A read-only call answers from the manifest and
// never starts the adapter. The dbt adapter is replaced through `dbtAdapterInternals`,
// so these tests need no Python or dbt.
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
  disposeDbtAdapter,
  getDbtAdapter,
  getDbtProjectRoot,
  resetDbtAdapter,
} from "@/altimate/native/connections/register"
import { DbtLineageTool, dbtLineageInternals, isModelLineage } from "@/altimate/tools/dbt-lineage"
import type { ModelLineage } from "@/altimate/native/types"
import { lineageManifest } from "./dbt-model-lineage.fixture"
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

/** What dbt-tools reads for a project found without a dbt.json, unless a mode is given. */
function useConfig(dbtIntegration = "corecommand") {
  dbtAdapterInternals.readConfig = async () => ({
    projectRoot: project,
    pythonPath: "python3",
    dbtIntegration,
    queryLimit: 500,
  })
}

beforeAll(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "dbt-lineage-structured-"))
  await writeFile(path.join(project, "dbt_project.yml"), "name: jaffle_shop\n")
  await mkdir(path.join(project, "target"))
  await writeFile(path.join(project, "target", "manifest.json"), JSON.stringify(lineageManifest()))
})

/** A manifest answer: version-1 lineage, with the reason in the structured result and the text. */
function expectManifestAnswer(result: { output: string; metadata: Record<string, any> }, reason: string) {
  const content = result.metadata.structuredContent
  // Read before any toMatchObject: bun's writes its asymmetric matchers into the object it checks.
  expect(content.reason).toContain(reason)
  expect(content.reason).toContain("upstream_depth and downstream_depth don't apply")
  expect([content.engine, content.version]).toEqual(["manifest", 1])
  expect(isModelLineage(content)).toBe(true)
  expect(result.output).toContain(`dbt integration not used: ${reason}`)
}

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
})

describe("dbt_lineage with the project's dbt adapter", () => {
  beforeEach(() => {
    useConfig()
    dbtAdapterInternals.create = async () =>
      fakeAdapter(true, async (params) => {
        requests.push(params)
        return TRACE
      })
  })

  test("returns dbt-integration's result as structured content, with a readable text", async () => {
    const tool = await initTool(DbtLineageTool)
    const result = await tool.execute({ model: "customers", column: "customer_lifetime_value" }, ctx)
    expect(requests).toEqual([
      { model: "customers", column: "customer_lifetime_value", upstreamDepth: 3, downstreamDepth: 3 },
    ])
    expect(result.metadata.structuredContent).toEqual({ engine: "dbt-integration", ...TRACE })
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

  test("passes the depths it is given", async () => {
    const tool = await initTool(DbtLineageTool)
    await tool.execute({ model: "customers", upstream_depth: 1, downstream_depth: 0 }, ctx)
    expect(requests).toEqual([{ model: "customers", upstreamDepth: 1, downstreamDepth: 0 }])
  })

  test("is handed to an MCP client that allowed writes as structuredContent", async () => {
    const server = await createServer({ allowWrite: true })
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
      expect(answer.structuredContent).toEqual({ engine: "dbt-integration", ...TRACE })
      expect((answer.content as { text: string }[])[0].text).toContain("Trace of customers.customer_lifetime_value")
    } finally {
      await client.close()
      await server.close()
    }
  })
})

describe("dbt_lineage without dbt-integration's lineage", () => {
  // The real manifest handler runs: the project's target/manifest.json, or none in the working directory.
  const manifestOnly = () => spyOn(Dispatcher, "call")

  test("falls back to the manifest when there is no dbt project", async () => {
    dbtAdapterInternals.readConfig = async () => null
    const call = manifestOnly()
    try {
      const tool = await initTool(DbtLineageTool)
      const result = await tool.execute({ model: "customers" }, ctx)
      expect(call).toHaveBeenCalledWith("dbt.model_lineage", {
        manifest_path: path.join("target", "manifest.json"),
        model: "customers",
        dialect: undefined,
      })
      expectManifestAnswer(result, "no dbt project here")
      expect(result.metadata.structuredContent.errors).toEqual(["Manifest file not found"])
    } finally {
      call.mockRestore()
    }
  })

  test("says the adapter couldn't start when the project is there but creating it fails", async () => {
    useConfig()
    dbtAdapterInternals.create = async () => {
      throw new Error("Cannot find module 'python-bridge'")
    }
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expectManifestAnswer(result, "the dbt adapter couldn't start for this project")
    } finally {
      call.mockRestore()
    }
  })

  test("falls back when the dbt-integration in use has no getModelLineage", async () => {
    useConfig()
    dbtAdapterInternals.create = async () => fakeAdapter(true)
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expectManifestAnswer(result, "dbt-integration has no getModelLineage")
    } finally {
      call.mockRestore()
    }
  })

  test("falls back when the adapter didn't load the project", async () => {
    useConfig()
    dbtAdapterInternals.create = async () =>
      fakeAdapter(false, async () => {
        throw new Error("No manifest has been generated")
      })
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expectManifestAnswer(result, "the dbt adapter didn't load the project")
    } finally {
      call.mockRestore()
    }
  })

  test("reads the manifest of the project the adapter found, not the working directory's", async () => {
    useConfig()
    dbtAdapterInternals.create = async () => fakeAdapter(true)
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expect(call.mock.calls[0]?.[1]).toMatchObject({ manifest_path: path.join(project, "target", "manifest.json") })
      const content = result.metadata.structuredContent as ModelLineage
      expect(content.nodes.map((n) => [n.uniqueId, n.direction])).toEqual([
        ["model.jaffle_shop.customers", "focus"],
        ["model.jaffle_shop.stg_customers", "upstream"],
        ["model.jaffle_shop.stg_orders", "upstream"],
        ["source.jaffle_shop.stripe.payments", "upstream"],
      ])
      expect(content.columnLineage).toContainEqual(
        expect.objectContaining({
          source: ["model.jaffle_shop.stg_customers", "first_name"],
          target: ["model.jaffle_shop.customers", "first_name"],
        }),
      )
      expect(result.output).toContain("customers.first_name ← stg_customers.first_name")
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

  test("says the manifest's column trace is one hop, and keeps only the edges into that column", async () => {
    useConfig()
    dbtAdapterInternals.create = async () => fakeAdapter(true)
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers", column: "first_name" }, ctx)
      expectManifestAnswer(result, "dbt-integration has no getModelLineage")
      const content = result.metadata.structuredContent as ModelLineage & { reason: string }
      expect(content.reason).toContain("the trace of first_name is one hop: the edges into it from those parents")
      expect(content.focus.column).toBe("first_name")
      expect(content.columnLineage.map((e) => e.target)).toEqual([["model.jaffle_shop.customers", "first_name"]])
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
    useConfig()
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

  test("stops on a call cancelled while the fallback looks for the manifest", async () => {
    const controller = new AbortController()
    useConfig()
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
    useConfig()
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

  test("a call cancelled while the tool loads the adapter module starts nothing", async () => {
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
      // execute runs up to its first await (the module import) before this abort.
      const running = tool.execute({ model: "customers" }, { ...ctx, abort: controller.signal })
      controller.abort()
      await expect(running).rejects.toThrow()
      expect(created).toBe(0)
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
      expectManifestAnswer(result, "the dbt adapter didn't start within 0.02 s")
      expect(call).toHaveBeenCalled()
    } finally {
      dbtLineageInternals.adapterStartTimeoutMs = saved
      call.mockRestore()
    }
  })

  test("falls back when the adapter returns a lineage it can't read", async () => {
    useConfig()
    dbtAdapterInternals.create = async () => fakeAdapter(true, async () => ({ version: 1, nodes: "?" }))
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "customers" }, ctx)
      expectManifestAnswer(result, "dbt-integration returned a lineage this tool can't read")
    } finally {
      call.mockRestore()
    }
  })

  test("falls back with the reason when the lookup fails", async () => {
    useConfig()
    dbtAdapterInternals.create = async () =>
      fakeAdapter(true, async () => {
        throw new Error("Model 'nope' is not in the project's manifest")
      })
    const call = manifestOnly()
    try {
      const result = await (await initTool(DbtLineageTool)).execute({ model: "nope" }, ctx)
      expectManifestAnswer(result, "Model 'nope' is not in the project's manifest")
      expect(result.metadata.structuredContent).toMatchObject({
        focus: { uniqueId: "nope", name: "nope" },
        nodes: [],
        errors: ["Model 'nope' not found in manifest"],
      })
    } finally {
      call.mockRestore()
    }
  })
})

describe("dbt_lineage in a read-only call", () => {
  let created: string[]
  let ran: string[]
  beforeEach(() => {
    created = []
    ran = []
    useConfig()
    dbtAdapterInternals.create = async (config: { dbtIntegration: string }) => {
      created.push(config.dbtIntegration)
      return {
        ...fakeAdapter(true, async () => TRACE),
        immediatelyExecuteSQL: async (sql: string) => {
          ran.push(sql)
          return { columnNames: ["n"], columnTypes: ["integer"], data: [{ n: 1 }] }
        },
      }
    }
  })
  const manifestOnly = () => spyOn(Dispatcher, "call")

  test("answers from the manifest and never creates the dbt adapter", async () => {
    const call = manifestOnly()
    try {
      const tool = await initTool(DbtLineageTool)
      const result = await tool.execute(
        { model: "customers", column: "customer_id" },
        { ...ctx, extra: { forceReadOnly: true } },
      )
      expect(created).toEqual([])
      expect(call).toHaveBeenCalledTimes(1)
      expect(call.mock.calls[0]?.[0]).toBe("dbt.model_lineage")
      expectManifestAnswer(result, "this session is read-only")
      expect((result.metadata.structuredContent as ModelLineage).nodes).toHaveLength(4)
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
    expect(await register.getDbtAdapter()).toBeTruthy()
    const call = manifestOnly()
    try {
      const tool = await initTool(DbtLineageTool)
      const result = await tool.execute({ model: "customers" }, { ...ctx, extra: { forceReadOnly: true } })
      expect(lookups).toEqual([])
      expectManifestAnswer(result, "this session is read-only")
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
      expect(answer.structuredContent).toMatchObject({ engine: "manifest", version: 1 })
      expect(isModelLineage(answer.structuredContent)).toBe(true)
      expect(created).toEqual([])
      call.mockRestore()
      await client.callTool({ name: "sql_execute", arguments: { query: "create table t as select 1 as n" } })
      expect(ran).toEqual([])
    } finally {
      call.mockRestore()
      await client.close()
      await server.close()
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
})
