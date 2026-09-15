// altimate_change - new file
//
// The MCP catalog keeps the `_meta` of a server's last tools/list page per
// client (the workspace engine reports unserved allowlist keys there), even
// though pagination keeps only the tools themselves.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import * as McpCatalog from "../../src/mcp/catalog"

const KEY = "ai.altimate/unfulfilled"

async function connected(listTools: () => Record<string, unknown>) {
  const server = new Server({ name: "fake", version: "0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => listTools() as never)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(clientTransport)
  return { client, close: () => Promise.all([client.close(), server.close()]) }
}

const echo = { name: "echo", description: "", inputSchema: { type: "object", properties: {} } }

describe("McpCatalog.listMeta", () => {
  test("keeps the last tools/list page's _meta next to the listed tools", async () => {
    const report = [{ key: "jira_search_issues", integrationId: "jira", reason: "invalid-connection" }]
    const { client, close } = await connected(() => ({ tools: [echo], _meta: { [KEY]: report } }))
    try {
      expect(McpCatalog.listMeta(client)).toBeUndefined()
      const defs = await Effect.runPromise(McpCatalog.defs(client))
      expect(defs?.map((t) => t.name)).toEqual(["echo"])
      expect(McpCatalog.listMeta(client)).toEqual({ [KEY]: report })
    } finally {
      await close()
    }
  })

  test("a listing that carries no _meta clears what an earlier one left", async () => {
    let withMeta = true
    const { client, close } = await connected(() =>
      withMeta ? { tools: [echo], _meta: { [KEY]: [] } } : { tools: [echo] },
    )
    try {
      await Effect.runPromise(McpCatalog.defs(client))
      expect(McpCatalog.listMeta(client)).toEqual({ [KEY]: [] })
      withMeta = false
      await Effect.runPromise(McpCatalog.defs(client))
      expect(McpCatalog.listMeta(client)).toBeUndefined()
    } finally {
      await close()
    }
  })

  test("_meta survives the multi-page path", async () => {
    let page = 0
    const { client, close } = await connected(() => {
      page += 1
      return page === 1
        ? { tools: [echo], nextCursor: "p2" }
        : { tools: [{ ...echo, name: "echo2" }], _meta: { [KEY]: [] } }
    })
    try {
      const defs = await Effect.runPromise(McpCatalog.defs(client))
      expect(defs?.map((t) => t.name)).toEqual(["echo", "echo2"])
      expect(McpCatalog.listMeta(client)).toEqual({ [KEY]: [] })
    } finally {
      await close()
    }
  })

  test("a _meta on the first page is kept when the last page carries none", async () => {
    // The rule is "the last page that carries one wins", stated so it is not
    // mistaken for per-page clearing. (multi-model review)
    let page = 0
    const { client, close } = await connected(() => {
      page += 1
      return page === 1
        ? { tools: [echo], nextCursor: "p2", _meta: { [KEY]: [{ key: "x", integrationId: "i", reason: "unknown-key" }] } }
        : { tools: [{ ...echo, name: "echo2" }] }
    })
    try {
      await Effect.runPromise(McpCatalog.defs(client))
      expect(McpCatalog.listMeta(client)).toEqual({ [KEY]: [{ key: "x", integrationId: "i", reason: "unknown-key" }] })
    } finally {
      await close()
    }
  })

  test("a listing that fails part-way leaves the previous _meta standing", async () => {
    // Cleared at the start of a listing, a refresh that failed on its second
    // page left the tools of the last good listing beside no report at all.
    let attempt = 0
    let page = 0
    const { client, close } = await connected(() => {
      if (attempt === 0) return { tools: [echo], _meta: { [KEY]: [] } }
      page += 1
      if (page === 1) return { tools: [echo], nextCursor: "p2", _meta: { [KEY]: [{ key: "y", integrationId: "i", reason: "exception" }] } }
      throw new Error("second page exploded")
    })
    try {
      await Effect.runPromise(McpCatalog.defs(client))
      expect(McpCatalog.listMeta(client)).toEqual({ [KEY]: [] })
      attempt = 1
      expect(await Effect.runPromise(McpCatalog.defs(client))).toBeUndefined()
      expect(McpCatalog.listMeta(client)).toEqual({ [KEY]: [] })
    } finally {
      await close()
    }
  })
})
