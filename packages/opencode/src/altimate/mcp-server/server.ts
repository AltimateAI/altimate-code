import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { isLocalFilePath, type ConnectionConfig } from "@altimateai/drivers"
import * as Registry from "../native/connections/registry"
import { createAdapter, descriptions } from "./adapter"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export interface ServeOptions {
  connections?: string
  allowWrite?: boolean
}

export async function createServer(options: ServeOptions = {}) {
  if (options.connections) {
    const file = path.resolve(options.connections)
    const configs: unknown = JSON.parse(await readFile(file, "utf8"))
    if (!configs || typeof configs !== "object" || Array.isArray(configs))
      throw new Error("Connections file must contain an object keyed by connection name")
    const resolved: Record<string, ConnectionConfig> = {}
    for (const [name, value] of Object.entries(configs)) {
      if (!value || typeof value !== "object" || typeof value.type !== "string")
        throw new Error(`Invalid connection: ${name}`)
      const config = { ...value } as ConnectionConfig
      if (
        ["duckdb", "sqlite"].includes(config.type.toLowerCase()) &&
        typeof config.path === "string" &&
        isLocalFilePath(config.path) &&
        !path.isAbsolute(config.path) &&
        !path.win32.isAbsolute(config.path)
      ) {
        config.path = path.resolve(path.dirname(file), config.path)
      }
      resolved[name] = config
    }
    Registry.setConfigs(resolved)
  }
  const adapter = await createAdapter(options)
  const server = new Server({ name: "altimate-code", version: InstallationVersion }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...adapter.tools].map(([name, tool]) => ({
      name,
      description: descriptions[name],
      inputSchema: tool.jsonSchema as McpTool["inputSchema"],
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const result = await adapter.execute(request.params.name, request.params.arguments ?? {}, extra.signal)
      const isError = result.status === "error" || (result.metadata.success !== true && Boolean(result.metadata.error))
      return { content: [{ type: "text" as const, text: result.output }], isError }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  })
  server.onclose = async () => {
    await adapter.close().catch(console.error)
  }
  return server
}

export async function serveStdio(options: ServeOptions = {}): Promise<void> {
  // Protocol writes use the transport's stdout directly; application logging must use stderr.
  console.log = console.error.bind(console)
  console.info = console.error.bind(console)
  console.debug = console.error.bind(console)
  const server = await createServer(options)
  server.onerror = (error) => console.error(error)
  const closed = Promise.withResolvers<void>()
  const onclose = server.onclose
  server.onclose = async () => {
    try {
      await onclose?.()
      await Registry.closeAll()
      closed.resolve()
    } catch (error) {
      closed.reject(error)
    }
  }
  const close = () => {
    void server.close().catch(closed.reject)
  }
  process.stdin.once("end", close)
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
  try {
    await server.connect(new StdioServerTransport())
    await closed.promise
  } finally {
    process.stdin.off("end", close)
    process.off("SIGINT", close)
    process.off("SIGTERM", close)
  }
}
