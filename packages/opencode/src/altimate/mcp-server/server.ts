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
import { createAdapter, descriptions, resultFailed } from "./adapter"
import { catalogSummary } from "../tools/warehouse-discovery"
import { readOnlyCaveat } from "../native/connections/read-only"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export const SERVER_INSTRUCTIONS = [
  "Analyst method for data questions:",
  "1. Connections are listed below (warehouse_list adds columns and a sample row); if none fit, warehouse_add one.",
  "2. Check stored value formats before filtering or joining: sql_execute `tables` returns value profiles in the same call as your queries.",
  "3. Compute in the database; chain dependent steps (any connection) in one sql_execute `queries` call.",
  "4. Cross-connection joins: sql_materialize the smaller filtered side into `scratch` and join there.",
  "5. End with `FINAL ANSWER: <value(s)>` naming every requested item (entity and related item both); answer_commit is optional.",
].join("\n")

/**
 * The analyst method plus the connection list known at startup (names and types from config; table names only for
 * small local SQLite/DuckDB files, see catalogSummary), so a client can start querying without a warehouse_list round
 * trip. Remote connections are never contacted here. A failing or empty listing leaves the method alone.
 */
export async function serverInstructions(): Promise<string> {
  try {
    const warehouses = Registry.list().warehouses
    if (!warehouses.length) return SERVER_INSTRUCTIONS
    const summary = await catalogSummary(warehouses)
    return summary ? `${SERVER_INSTRUCTIONS}\n\nConnections:\n${summary}` : SERVER_INSTRUCTIONS
  } catch {
    return SERVER_INSTRUCTIONS
  } finally {
    // The catalog listing opens local SQLite/DuckDB files; release them so other processes can open them while idle.
    await Registry.releaseFileConnections().catch(() => {})
  }
}

// altimate_change start — lineage tools answer with structured content as well as text
// Lineage tools also return their metadata as structured content, so a client that draws lineage
// (the Claude Code plugin's lineage pane) reads edges and downstream lists without parsing text.
// Claude Code shows structured content to the model in place of the text, so `report` carries the
// (already truncated) text (dbt_lineage: its header, its mappings travel as data), only the lineage
// fields are passed, and the whole is capped.
const STRUCTURED_FIELDS: Record<string, readonly string[]> = {
  dbt_lineage: ["model_name", "model_unique_id", "confidence", "confidence_factors", "upstream", "columns", "edges", "error"],
  impact_analysis: [
    "model",
    "column",
    "change_type",
    "severity",
    "direct_count",
    "transitive_count",
    "test_count",
    "downstream",
    "exposures",
    "column_reach",
    "column_reach_error",
    "exposures_error",
    "error",
  ],
}
export const STRUCTURED_TOOLS: ReadonlySet<string> = new Set(Object.keys(STRUCTURED_FIELDS))
const STRUCTURED_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    report: { type: "string", description: "The tool's text report" },
    truncated: { type: "boolean", description: "True when the lineage fields were left out for size; the report stands" },
  },
  required: ["report"],
  additionalProperties: true,
}
// The structured result reaches the model in Claude Code, so it stays within the same order of
// size as a text result: past this, only the report is sent.
const STRUCTURED_MAX_BYTES = 100_000

export function structuredResult(tool: string, metadata: Record<string, unknown>, report: string): Record<string, unknown> {
  // A tool that builds its own structured result (dbt_lineage from the dbt integration) hands it
  // over whole; otherwise the lineage fields of its metadata are passed.
  const own = metadata.structuredContent
  if (own && typeof own === "object" && !Array.isArray(own)) {
    const full = { ...(own as Record<string, unknown>), report }
    return Buffer.byteLength(JSON.stringify(full)) <= STRUCTURED_MAX_BYTES ? full : { report, truncated: true }
  }
  const fields = Object.fromEntries((STRUCTURED_FIELDS[tool] ?? []).filter((key) => key in metadata).map((key) => [key, metadata[key]]))
  // dbt_lineage's text prints the same mappings and edges as `columns` and `edges`: keep its header.
  const head = tool === "dbt_lineage" && "columns" in fields ? report.split("\nColumn Mappings:")[0]!.trim() : report
  const full = { ...fields, report: head }
  return Buffer.byteLength(JSON.stringify(full)) <= STRUCTURED_MAX_BYTES ? full : { report, truncated: true }
}
/** An error report held to the same cap as a result, so a huge exception message cannot exceed it. */
export function structuredError(message: string): Record<string, unknown> {
  // Measured as sent: JSON escaping can grow the text (a newline is two bytes, a control
  // character six), so the cap applies to the serialized result, shortening until it fits.
  const size = (value: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(value))
  if (size({ report: message }) <= STRUCTURED_MAX_BYTES) return { report: message }
  let report = message
  while (report.length > 0 && size({ report, truncated: true }) > STRUCTURED_MAX_BYTES) {
    report = report.slice(0, Math.floor(report.length * 0.9))
  }
  return { report, truncated: true }
}
// altimate_change end

/** Spilled results: a resource_link next to the text, which keeps the preview, row count and path. */
function resultLinks(metadata: Record<string, unknown>) {
  // A batched sql_execute call reports one saved file per spilled query.
  const batch = Array.isArray(metadata.result_paths) ? metadata.result_paths : []
  const single = [metadata.result_path, metadata.outputPath].find((value) => typeof value === "string" && value)
  const files = [...new Set([...batch, ...(batch.length ? [] : [single])])].filter(
    (file): file is string => typeof file === "string" && !!file,
  )
  return files.map((file) => ({
    type: "resource_link" as const,
    uri: pathToFileURL(file).href,
    name: path.basename(file),
    mimeType: file.endsWith(".jsonl") ? "application/x-ndjson" : file.endsWith(".csv") ? "text/csv" : "text/plain",
  }))
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
  // Advertise every tool in the allow-list (default: the lean set plus a few extras, see adapter DEFAULT_TOOLS).
  allTools?: boolean
  workspaceTools?: boolean
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
  const workspace = options.workspaceTools ? await (await import("./workspace")).createWorkspaceAdapter(process.cwd()) : undefined
  const server = new Server({ name: "altimate-code", version: InstallationVersion }, {
    capabilities: { tools: {}, prompts: {} },
    instructions: await serverInstructions(),
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...[...adapter.tools].map(([name, tool]) => ({
      name,
      description: descriptions[name] ?? tool.description,
      inputSchema: tool.jsonSchema as McpTool["inputSchema"],
      ...(STRUCTURED_TOOLS.has(name) && { outputSchema: STRUCTURED_OUTPUT_SCHEMA }),
    })), ...(workspace?.tools ?? [])],
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
  // Calls in flight; when the last one finishes, embedded file databases are released so another process (dbt, a
  // second client) can open them while this server idles.
  let inflight = 0
  const callTool: Parameters<typeof server.setRequestHandler<typeof CallToolRequestSchema>>[1] = async (request, extra) => {
    try {
      if (workspace?.tools.some((tool) => tool.name === request.params.name)) {
        return await workspace.execute(request.params.name, request.params.arguments ?? {}, extra.signal)
      }
      const result = await adapter.execute(request.params.name, request.params.arguments ?? {}, extra.signal)
      const clarified = request.params.name === "answer_commit" ? await clarifyReading(request.params.arguments, result, extra.signal) : undefined
      if (clarified) return { content: [{ type: "text" as const, text: clarified }], isError: true }
      const isError = resultFailed(result)
      // A tool that builds a structured result (dbt_lineage) hands it over beside its text.
      const structured = result.metadata?.structuredContent
      return {
        content: [{ type: "text" as const, text: result.output }, ...resultLinks(result.metadata)],
        // Tools outside the declared set may still hand over a structured result of their own.
        ...(structured && typeof structured === "object" && !isError && !STRUCTURED_TOOLS.has(request.params.name)
          ? { structuredContent: structured as Record<string, unknown> }
          : {}),
        isError,
        ...(STRUCTURED_TOOLS.has(request.params.name) && {
          structuredContent: structuredResult(request.params.name, result.metadata, result.output),
        }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
        ...(STRUCTURED_TOOLS.has(request.params.name) && { structuredContent: structuredError(message) }),
      }
    }
  }
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    inflight++
    try {
      return await callTool(request, extra)
    } finally {
      inflight--
      if (inflight === 0) await Registry.releaseFileConnections().catch(() => {})
    }
  })
  let cleanup: Promise<void> | undefined
  const dispose = () => (cleanup ??= Promise.all([adapter.close(), workspace?.close()]).then(() => {}))
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
  // The process serves only this server: without --allow-write, sql_execute never runs through
  // dbt in it. (`createServer` can run more than once in a process, so it doesn't declare.)
  if (!options.allowWrite) (await import("../native/connections/register")).declareNoDbtUserSql()
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
