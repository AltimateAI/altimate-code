import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js"
import * as Registry from "../native/connections/registry"
import { createAdapter, descriptions } from "./adapter"
import { readOnlyCaveat } from "../native/connections/read-only"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export const SERVER_INSTRUCTIONS = [
  "Analyst method for data questions:",
  "1. Start with warehouse_list, then schema_inspect without `table` to see the tables.",
  "2. Read schema_inspect's value profile (ranked values, distinct/null counts, unique flag, value shapes) before choosing columns or join keys; formats often differ across databases.",
  "3. Compute in the database.",
  "4. For joins across connections, sql_materialize the smaller filtered side into `scratch` and join there.",
  "5. Run sql_check when keys, fan-out, grain or nulls could change the answer.",
  "6. Check that every condition in the question actually filters something.",
  "7. Finish with answer_commit: `asked` lists the requested items, one field per item; reply with exactly the FINAL ANSWER text it returns.",
].join("\n")

/** Spilled results: a resource_link next to the text, which keeps the preview, row count and path. */
function resultLinks(metadata: Record<string, unknown>) {
  const file = [metadata.result_path, metadata.outputPath].find((value) => typeof value === "string" && value)
  if (typeof file !== "string") return []
  return [
    {
      type: "resource_link" as const,
      uri: pathToFileURL(file).href,
      name: path.basename(file),
      mimeType: file.endsWith(".jsonl") ? "application/x-ndjson" : "text/plain",
    },
  ]
}

export interface ServeOptions {
  connections?: string
  allowWrite?: boolean
}

export async function createServer(options: ServeOptions = {}) {
  if (options.connections) await Registry.loadFile(options.connections)
  if (!options.allowWrite) {
    for (const connection of Registry.list().warehouses) {
      const caveat = readOnlyCaveat(connection)
      if (caveat) console.error(caveat)
    }
  }
  const adapter = await createAdapter(options)
  const server = new Server({ name: "altimate-code", version: InstallationVersion }, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  })
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
      return { content: [{ type: "text" as const, text: result.output }, ...resultLinks(result.metadata)], isError }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  })
  let cleanup: Promise<void> | undefined
  const dispose = () => (cleanup ??= adapter.close())
  server.onclose = async () => {
    await dispose().catch(console.error)
  }
  const close = server.close.bind(server)
  server.close = async () => {
    try {
      await close()
    } finally {
      await dispose()
    }
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
    await server.close()
    await Registry.closeAll()
  }
}
