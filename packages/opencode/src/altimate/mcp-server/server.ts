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

// Surfaces as a slash command in interactive clients.
const analyzePrompt = {
  name: "analyze",
  description: "Answer a data question with the analyst method: inspect, compute in the database, then answer_commit.",
  arguments: [{ name: "question", description: "The data question to answer", required: false }],
}

export interface ServeOptions {
  connections?: string
  allowWrite?: boolean
  // Bounds the reading question so an unanswered prompt cannot outlast the client's tool-call timeout.
  elicitTimeoutMs?: number
}

const ELICIT_TIMEOUT_MS = 20_000

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
    capabilities: { tools: {}, prompts: {} },
    instructions: SERVER_INSTRUCTIONS,
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...adapter.tools].map(([name, tool]) => ({
      name,
      description: descriptions[name],
      inputSchema: tool.jsonSchema as McpTool["inputSchema"],
    })),
  }))
  // Ask the user once per session when the model weighed two readings and the client can ask; any
  // failure, decline or cancel (headless clients cancel) leaves the commit as accepted.
  let elicited = false
  const clarifyReading = async (
    args: Record<string, unknown> | undefined,
    result: { status?: string },
    signal: AbortSignal,
  ) => {
    const readings = Array.isArray(args?.readings) ? (args.readings as { reading?: unknown }[]) : []
    const choices = readings.map((item) => item.reading).filter((item): item is string => typeof item === "string" && !!item)
    if (elicited || result.status === "error" || choices.length < 2 || !server.getClientCapabilities()?.elicitation) return undefined
    elicited = true
    try {
      const answer = await server.elicitInput({
        message: "The question can be read two ways. Which did you mean?",
        requestedSchema: {
          type: "object",
          properties: { reading: { type: "string", enum: choices, description: "Intended reading" } },
          required: ["reading"],
        },
      }, { signal, timeout: options.elicitTimeoutMs ?? ELICIT_TIMEOUT_MS })
      const chosen = answer.action === "accept" ? answer.content?.reading : undefined
      if (typeof chosen !== "string" || chosen === choices[0]) return undefined
      return `The user chose this reading: ${JSON.stringify(chosen)}. Recompute under it and call answer_commit again.`
    } catch {
      return undefined
    }
  }
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [analyzePrompt] }))
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name !== analyzePrompt.name) throw new Error(`Unknown prompt: ${request.params.name}`)
    const question = request.params.arguments?.question?.trim()
    const text = [SERVER_INSTRUCTIONS, ...(question ? ["", `Question: ${question}`] : [])].join("\n")
    return { description: analyzePrompt.description, messages: [{ role: "user" as const, content: { type: "text" as const, text } }] }
  })
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const result = await adapter.execute(request.params.name, request.params.arguments ?? {}, extra.signal)
      const clarified = request.params.name === "answer_commit" ? await clarifyReading(request.params.arguments, result, extra.signal) : undefined
      if (clarified) return { content: [{ type: "text" as const, text: clarified }], isError: true }
      const isError = result.status === "error" || (result.metadata.success !== true && Boolean(result.metadata.error))
      return {
        content: [{ type: "text" as const, text: result.output }, ...resultLinks(result.metadata)],
        isError,
      }
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
