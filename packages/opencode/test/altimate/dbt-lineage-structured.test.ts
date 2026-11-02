// altimate_change - new file
//
// dbt_lineage returns dbt-integration's structured lineage when the project's dbt
// adapter is up, and the adapter prefers the Python-bridge mode for a project found
// without a dbt.json. The dbt adapter is replaced through `dbtAdapterInternals`, so
// these tests need no Python or dbt.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
  getDbtAdapter,
  resetDbtAdapter,
} from "@/altimate/native/connections/register"
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

function useConfig(autoDiscovered: boolean, dbtIntegration = "corecommand") {
  dbtAdapterInternals.readConfig = async () => ({
    projectRoot: project,
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
    expect(at).toEqual([...at].sort((a, b) => a - b))
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
      expect(answer.structuredContent).toEqual(TRACE)
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

  test("it falls back when the bridge can't start at all", async () => {
    useConfig(true)
    dbtAdapterInternals.create = creating({ core: "throws", corecommand: true })
    expect(await getDbtAdapter()).toMatchObject({ mode: "corecommand" })
    expect(tried).toEqual(["core", "corecommand"])
  })

  test("a dbt.json's mode is used as configured", async () => {
    useConfig(false)
    dbtAdapterInternals.create = creating({ core: true, corecommand: true })
    expect(await getDbtAdapter()).toMatchObject({ mode: "corecommand" })
    expect(tried).toEqual(["corecommand"])
  })
})
