import { FSUtil } from "@opencode-ai/core/fs-util"
import { NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, chmod, lstat, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { outputLimits } from "./output-settings"
import { renderAnswer } from "../tools/answer-commit"
import { AnswerCommitConjunction } from "../tools/answer-commit-conjunction"
import { MAX_SCANNED_CHARACTERS } from "../tools/answer-commit-checks"
import * as Precedence from "../workspace/precedence"
// altimate_change start — one tool set shared by `mcp serve` and `tool`
import { EXPOSED, MCP_OPEN_WRITE_TOOLS, WRITE_TOOLS } from "../tool-cli/allow-list"
import { askFor, denied } from "../tool-cli/permissions"
// altimate_change end
import { closeScratch } from "../native/connections/scratch"
import type { SessionID, MessageID } from "@/session/schema"

export const descriptions: Record<string, string> = {
  warehouse_list: "List connections; for local databases also tables, columns and a sample row.",
  warehouse_add: "Add a connection when warehouse_list shows none or the one you need is missing.",
  schema_inspect: "List tables when table is omitted; otherwise one table's columns and value profile.",
  sql_execute:
    "Run SQL and return rows. Chain queries in one call with `queries`: a later one can use IN ({{label.column}}) (an earlier result's values) or {{label}} (its rows as a scratch table, warehouse scratch). `tables` describes tables first. Source writes need --allow-write.",
  sql_check: "Read-only data check: fanout, keys, grain, nulls or coverage.",
  sql_materialize: "Store a read-only query's rows as a scratch table, to join across connections.",
  answer_commit:
    "Finish a data question; call last, then reply with exactly its FINAL ANSWER text. Use one of fields, rows or unresolved, with a field (or rows column) per asked item, named after it. Never collapse a compound request into one field: 'the repository and the most copied file' needs two. An item that only selects the answer ('the customer with the largest invoice') is not asked. Numbers may be your own computation; exact decimals as strings.",
}

/**
 * Short MCP property descriptions, keyed by property path (`a.b` nests, `a[]` is an array's items).
 * Every tool definition is re-sent on each model request, so the advertised schema keeps only what a
 * caller needs to choose and fill a property; `null` drops the description, `DROP` the property.
 */
const DROP = Symbol("drop")
const PROPERTY_DESCRIPTIONS: Record<string, Record<string, string | null | typeof DROP>> = {
  warehouse_add: {
    name: "Connection name",
    config:
      'Must include "type". postgres/mysql: host, port, database, user, password; mongodb: connection_string, ' +
      "database; duckdb/sqlite: path (absolute, existing file); snowflake/bigquery/others: their usual fields",
  },
  schema_inspect: {
    table: "Table, optionally schema-qualified; omit to list tables",
    schema_name: null,
    warehouse: null,
    values: "Include the value profile (default true)",
  },
  sql_execute: {
    query: "SQL, or a MongoDB JSON command",
    queries: "Up to 8 queries, run in order, one labeled result each",
    "queries[].label": null,
    "queries[].query": null,
    "queries[].warehouse": null,
    query_from: "Run the SQL string a one-row SELECT returns; warehouse is the target",
    "query_from.warehouse": null,
    "query_from.sql": null,
    warehouse: null,
    limit: "Max rows (default 100, max 10000)",
    full_text_columns: "Columns to show in full (20-row preview)",
    query_timeout_ms: null,
  },
  sql_check: {
    sql: "SELECT for grain, nulls or coverage",
    columns: "Columns for grain or nulls",
    column: "Column for coverage",
    pattern: "Regex (SQLite: LIKE pattern)",
    left_sql: "SELECT for fanout or keys",
    right_sql: "SELECT for fanout or keys",
    on: "fanout: [left, right] column pairs",
    join: "inner (default) or left",
    left_col: "keys: left column",
    right_col: "keys: right column",
    left_warehouse: DROP,
    right_warehouse: DROP,
    query_timeout_ms: null,
  },
  sql_materialize: {
    source_warehouse: "Warehouse to read, or scratch",
    sql: "Read-only SELECT",
    target_table: "New scratch table name",
    mode: "create (default), replace or append",
    max_rows: null,
    max_bytes: null,
    query_timeout_ms: null,
  },
  answer_commit: {
    fields: null,
    "fields[].name": null,
    // Units can be part of a string value; the field stays accepted.
    "fields[].units": DROP,
    "fields[].precision": "Decimals",
    asked: "Requested items, in order",
    "rows.format": "lines: no header",
    "rows.values": "N rows if N is asked, even with ties",
    "rows.precision": "Decimals by column",
    "rows.note": "Tie or caveat",
    basis: "1-2 sentences: population, grain, source column, caveats",
    answer_only: "Reply is only the value(s)/table",
    readings: "If two readings fit: the chosen one; decided_by: the rejected one and why",
    request: "The question, verbatim",
  },
}

type JsonNode = Record<string, unknown>
const isNode = (value: unknown): value is JsonNode => typeof value === "object" && value !== null && !Array.isArray(value)

/** Strict-schema fillers the parsers accept for unused optional properties: null, "", [] and {}. */
function isFiller(node: unknown): boolean {
  if (!isNode(node)) return false
  if (node.type === "null") return true
  if (node.const === "" && node.type === "string") return true
  if (node.type === "array" && node.maxItems === 0) return true
  return node.type === "object" && isNode(node.properties) && Object.keys(node.properties).length === 0 && node.additionalProperties === false
}

/**
 * Collapses an optional property's filler union to its value schema (omitting the property means the
 * same to the parsers) and drops keys that only restate what the parsers enforce. Unions elsewhere,
 * such as nullable table cells, keep every member.
 */
function collapse(node: unknown, property = false): unknown {
  if (Array.isArray(node)) return node.map((item) => collapse(item))
  if (!isNode(node)) return node
  let copy: JsonNode = { ...node }
  if (property && Array.isArray(copy.anyOf)) {
    const kept = copy.anyOf.filter((member) => !isFiller(member))
    if (kept.length === 1 && isNode(kept[0])) {
      const { anyOf: _, ...rest } = copy
      copy = { ...(kept[0] as JsonNode), ...rest }
    } else copy.anyOf = kept
  }
  for (const key of ["$schema", "default", "propertyNames", "minItems", "additionalProperties"]) {
    if (key !== "additionalProperties" || copy[key] === false) delete copy[key]
  }
  if (copy.maximum === Number.MAX_SAFE_INTEGER) delete copy.maximum
  for (const [key, value] of Object.entries(copy)) {
    if (key === "properties" && isNode(value)) {
      copy.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, collapse(child, true)]))
    } else if (key === "items" || key === "prefixItems" || key === "anyOf" || (key === "additionalProperties" && isNode(value))) {
      copy[key] = collapse(value)
    }
  }
  return copy
}

/** The property schema at a description path, or undefined when the path does not exist. */
function propertyAt(schema: JsonNode, pathText: string): { owner: JsonNode; parent: JsonNode; name: string } | undefined {
  let node: unknown = schema
  const segments = pathText.split(".")
  for (const [index, segment] of segments.entries()) {
    const array = segment.endsWith("[]")
    const name = array ? segment.slice(0, -2) : segment
    const properties = isNode(node) ? node.properties : undefined
    if (!isNode(node) || !isNode(properties) || !isNode(properties[name])) return undefined
    if (index === segments.length - 1 && !array) return { owner: node, parent: properties, name }
    node = array ? (properties[name] as JsonNode).items : properties[name]
  }
  return undefined
}

/** The advertised MCP input schema: fillers collapsed and descriptions shortened. Parsing is unchanged. */
export function compactSchema<T>(name: string, schema: T): T {
  const copy = collapse(schema) as JsonNode
  for (const [pathText, description] of Object.entries(PROPERTY_DESCRIPTIONS[name] ?? {})) {
    const target = propertyAt(copy, pathText)
    if (!target) throw new Error(`MCP schema for ${name} has no property ${pathText}`)
    const property = target.parent[target.name] as JsonNode
    if (description === DROP) {
      // Only optional properties are dropped; a required one would make every call fail.
      if (Array.isArray(target.owner.required) && target.owner.required.includes(target.name))
        throw new Error(`MCP schema for ${name} cannot drop required property ${pathText}`)
      delete target.parent[target.name]
    } else if (description === null) delete property.description
    else property.description = description
  }
  return copy as T
}

// The native tool caps `basis` at 400 characters; over the MCP boundary the text is trimmed instead of rejected.
const BASIS_LIMIT = 400
const MCP_ONLY_TOOLS = new Set(["answer_commit"])

/**
 * Tool definitions are re-sent with every model request, so the default toolset is the five tools clients use
 * plus a few lineage, PII, diff and translation tools; `sql_execute.tables` covers table inspection in the same
 * call as the queries. `allTools` advertises every tool in the allow-list.
 */
const LEAN_TOOLS = new Set(["warehouse_list", "warehouse_add", "sql_execute", "sql_materialize", "answer_commit"])
/** High-value extras advertised next to the lean set by default; `allTools` advertises the whole allow-list. */
const DEFAULT_EXTRA_TOOLS = [
  "impact_analysis",
  "dbt_lineage",
  "altimate_core_column_lineage",
  "schema_detect_pii",
  "data_diff",
  "altimate_core_equivalence",
  "sql_translate",
]
export const DEFAULT_TOOLS: ReadonlySet<string> = new Set([...LEAN_TOOLS, ...DEFAULT_EXTRA_TOOLS])
export const ALL_TOOLS: readonly string[] = Object.keys(EXPOSED)
const MAX_FUSED_TABLES = 8

/** Adds `tables` to the advertised sql_execute schema: tables described in the same call, before its queries. */
function withTables<T>(schema: T): T {
  const copy = JSON.parse(JSON.stringify(schema)) as { properties?: Record<string, unknown> }
  copy.properties = {
    tables: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_FUSED_TABLES,
      description: "Tables to describe in this call (columns, value profile); query optional",
    },
    ...copy.properties,
  }
  return copy as T
}

function hasQuery(args: Record<string, unknown>): boolean {
  return Boolean(args.query) || Boolean(args.query_from) || (Array.isArray(args.queries) && args.queries.length > 0)
}

/** Session-level record the native commit checks read: tool outputs and rejections of the current turn. */
type TurnMessage = Tool.Context["messages"][number]
/**
 * The FINAL ANSWER line carries only the answer, rendered as answer_only would, so the
 * explanation never becomes part of the answer text a client copies. The basis is kept,
 * above that line, as context for the user.
 */
export function finalAnswerText(args: Record<string, unknown>, committed: string, request?: unknown): string {
  // Answer-only only for a complete commit: rows, or fields covering every item the request names.
  // Otherwise keep the committed text (basis on the line) so an item kept only in the basis is not lost.
  const fields = Array.isArray(args.fields) ? args.fields.length : 0
  const complete =
    Boolean(args.rows) ||
    (fields > 0 && fields >= AnswerCommitConjunction.requestedItems(typeof request === "string" ? request : "").count)
  if (!complete) return `FINAL ANSWER: ${committed}`
  let answer = committed
  try {
    answer = renderAnswer({ ...args, answer_only: true })
  } catch {
    // Rendering already succeeded once inside the tool; keep its text if this variant fails.
  }
  const basis = typeof args.basis === "string" && args.answer_only !== true ? args.basis.trim() : ""
  return basis ? `Basis: ${basis}\n\nFINAL ANSWER: ${answer}` : `FINAL ANSWER: ${answer}`
}

function userMessage(): TurnMessage {
  return { info: { role: "user" }, parts: [] } as unknown as TurnMessage
}
function toolMessage(tool: string, state: Record<string, unknown>): TurnMessage {
  return { info: { role: "assistant" }, parts: [{ type: "tool", tool, state }] } as unknown as TurnMessage
}

// No agent runtime or provider initialization; only local output settings are loaded.
const analyst = { name: "analyst", mode: "primary", permission: [], options: {} } as Agent.Info
function services(directory: string, limits: Awaited<ReturnType<typeof outputLimits>>) {
  return Layer.mergeAll(
    Layer.succeed(
      Agent.Service,
      Agent.Service.of({
        get: () => Effect.succeed(analyst),
        list: () => Effect.succeed([analyst]),
        defaultInfo: () => Effect.succeed(analyst),
        defaultAgent: () => Effect.succeed(analyst.name),
        generate: () => Effect.die(new Error("MCP data tools never generate agents or call a model")),
      }),
    ),
    Truncate.makeLayer({
      directory,
      limits: () => Effect.succeed(limits),
      hint: (file, outcome) =>
        `The tool call ${outcome === "error" ? "failed" : "succeeded"} but the output was truncated. Full output saved to: ${file}\nOpen this path with any file reader to inspect the remaining output.`,
    }).pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(NodePath.layer)),
  )
}

/**
 * MCP clients do not forward the user's message, so answer_commit takes the request as an MCP-only
 * argument; the adapter records it as the current turn's user text for the commit checks.
 */
function withRequest<T>(schema: T): T {
  const copy = JSON.parse(JSON.stringify(schema)) as { properties?: Record<string, unknown>; required?: string[] }
  copy.properties = {
    ...copy.properties,
    request: {
      type: "string",
      description:
        "The user's question, copied verbatim: only the question itself, without database descriptions or other context.",
    },
  }
  copy.required = [...(copy.required ?? []), "request"]
  return copy as T
}

function recordRequest(messages: TurnMessage[], request: unknown) {
  if (typeof request !== "string" || !request.trim()) return
  const turn = messages.findLast((message) => message.info.role === "user")
  if (turn) (turn as { parts: unknown[] }).parts = [{ type: "text", text: request.trim() }]
}

function relaxBasis<T>(schema: T): T {
  const copy = JSON.parse(JSON.stringify(schema).replaceAll(`at most ${BASIS_LIMIT} characters`, "kept brief")) as {
    properties?: { basis?: { maxLength?: number } }
  }
  delete copy.properties?.basis?.maxLength
  return copy as T
}

export interface AdapterOptions {
  allowWrite?: boolean
  allTools?: boolean
  // The `tool` CLI: also refuses the tools that change local configuration or install software without writes.
  cli?: boolean
  // Keep spilled results here after the adapter closes (the CLI exits before its caller reads them).
  // Files older than a day are pruned on start. Default: a private directory removed on close.
  resultsDir?: string
}

const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000

async function persistentDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Refusing to use the results directory ${directory}: it is a symlink.`)
  await chmod(directory, 0o700)
  const cutoff = Date.now() - RESULT_RETENTION_MS
  for (const name of await readdir(directory).catch(() => [])) {
    const file = path.join(directory, name)
    if ((await stat(file).catch(() => undefined))?.mtimeMs! < cutoff) await rm(file, { force: true })
  }
  return directory
}

/** A failed call: an error status, or a result that reports an error without success. */
export function resultFailed(result: Tool.ExecuteResult): boolean {
  return result.status === "error" || (result.metadata.success !== true && Boolean(result.metadata.error))
}

export async function createAdapter(options: AdapterOptions = {}) {
  const limits = await outputLimits()
  const directory = options.resultsDir
    ? await persistentDirectory(options.resultsDir)
    : await mkdtemp(path.join(tmpdir(), "altimate-code-mcp-results-"))
  if (!options.resultsDir) await chmod(directory, 0o700)
  const spillPrefix = options.resultsDir ? `result-${randomUUID().slice(0, 8)}-` : "result-"
  const sessionID = `mcp-${randomUUID()}` as SessionID
  Precedence.bindLocalSession(sessionID)
  const tools = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = new Map<string, Tool.Def>()
        for (const source of Object.values(EXPOSED)) {
          const info = yield* source
          const tool = yield* Tool.init(info, { agent: analyst })
          if (tool.jsonSchema) {
            tool.jsonSchema = JSON.parse(
              JSON.stringify(tool.jsonSchema).replaceAll(
                "use read with char_offset/max_chars to recover clipped text",
                "open result_path with any file reader to recover clipped text",
              ),
            )
          }
          if (tool.jsonSchema && info.id === "answer_commit") tool.jsonSchema = withRequest(relaxBasis(tool.jsonSchema))
          if (tool.jsonSchema) tool.jsonSchema = compactSchema(info.id, tool.jsonSchema)
          if (tool.jsonSchema && info.id === "sql_execute") tool.jsonSchema = withTables(tool.jsonSchema)
          result.set(info.id, tool)
        }
        return result
      }).pipe(Effect.provide(services(directory, limits))),
    ),
  ).catch(async (error) => {
    Precedence.releaseLocalSession(sessionID)
    if (!options.resultsDir) await rm(directory, { recursive: true, force: true })
    throw error
  })

  const messages: TurnMessage[] = [userMessage()]
  // Sequential spill names keep model-visible paths stable across runs, apart from the private directory.
  let spills = 0
  const writeSpill = async (text: string, extension: string) => {
    const file = path.join(directory, `${spillPrefix}${++spills}.${extension}`)
    await writeFile(file, text, { mode: 0o600, flag: "wx" })
    return file
  }
  const shutdown = new AbortController()
  const active = new Set<Promise<Tool.ExecuteResult>>()
  // Feed the native commit checks: completed tool output and rejections, with a new turn after an accepted commit.
  const record = (name: string, result: Tool.ExecuteResult, args: Record<string, unknown>, request?: unknown) => {
    if (name !== "answer_commit") {
      if (result.status !== "error") messages.push(toolMessage(name, { status: "completed", output: result.output }))
      return result
    }
    if (result.status === "error") {
      messages.push(toolMessage(name, { status: "error", error: result.output }))
      return result
    }
    messages.push(userMessage())
    // Earlier turns beyond what the commit checks can scan are dead weight; the new turn is never trimmed.
    const size = (message: TurnMessage) =>
      (message.parts as { state?: { output?: unknown }; text?: string }[]).reduce(
        (total, part) => total + String(part.state?.output ?? part.text ?? "").length,
        0,
      )
    let retained = messages.slice(0, -1).reduce((total, message) => total + size(message), 0)
    while (retained > MAX_SCANNED_CHARACTERS && messages.length > 1) retained -= size(messages.shift()!)
    return { ...result, output: finalAnswerText(args, result.metadata.committed_text ?? result.output, request) }
  }
  const advertised = new Map([...tools].filter(([name]) => options.allTools || DEFAULT_TOOLS.has(name)))
  /** sql_execute with `tables`: describe each table with schema_inspect, then run the queries, in one call. */
  const fused = async (tables: unknown[], args: Record<string, unknown>, ctx: Tool.Context): Promise<Tool.ExecuteResult> => {
    const inspect = tools.get("schema_inspect")!
    const parts: string[] = []
    let inspected = 0
    for (const table of tables.slice(0, MAX_FUSED_TABLES)) {
      if (typeof table !== "string" || !table.trim()) continue
      ctx.abort.throwIfAborted()
      const target = { table: table.trim(), ...(typeof args.warehouse === "string" ? { warehouse: args.warehouse } : {}) }
      try {
        const result = await Effect.runPromise(inspect.execute(target, ctx))
        if (result.status !== "error" && !result.metadata?.error) inspected++
        parts.push(result.output)
      } catch (error) {
        if (ctx.abort.aborted) throw error
        parts.push(`Table ${table}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    ctx.abort.throwIfAborted()
    if (!hasQuery(args)) {
      const output = parts.join("\n\n")
      // Nothing described and nothing queried: report a failure, not completed evidence.
      if (inspected === 0) return { title: "Schema: no table described", metadata: { error: output }, output, status: "error" }
      return { title: `Schema: ${inspected} table(s)`, metadata: {}, output }
    }
    const result = await Effect.runPromise(tools.get("sql_execute")!.execute(args, ctx))
    return { ...result, output: [...parts, result.output].join("\n\n") }
  }
  return {
    tools: advertised,
    async execute(name: string, args: Record<string, unknown>, signal: AbortSignal, call: { allowWrite?: boolean } = {}) {
      const allowWrite = call.allowWrite ?? options.allowWrite === true
      const retry = options.cli ? "Re-run" : "Restart"
      signal = AbortSignal.any([signal, shutdown.signal])
      signal.throwIfAborted()
      const tool = advertised.get(name)
      if (!tool) throw new Error(`Unknown tool: ${name}`)
      if (WRITE_TOOLS.has(name) && (options.cli || !MCP_OPEN_WRITE_TOOLS.has(name)) && !allowWrite) throw denied(name, retry)
      const ctx: Tool.Context = {
        sessionID,
        messageID: `mcp-${randomUUID()}` as MessageID,
        agent: "analyst",
        abort: signal,
        extra: { mcpClient: true, forceReadOnly: !allowWrite, writeSpill },
        messages,
        metadata: () => Effect.void,
        // Fail closed for new permission kinds. sql_execute is the validated source-read permission.
        ask: askFor(allowWrite, retry),
      }
      if (MCP_ONLY_TOOLS.has(name) && typeof args.basis === "string" && args.basis.length > BASIS_LIMIT)
        args = { ...args, basis: args.basis.slice(0, BASIS_LIMIT) }
      let request: unknown
      if (name === "answer_commit") {
        const { request: text, ...rest } = args
        request = text
        recordRequest(messages, request)
        args = rest
      }
      let pending: Promise<Tool.ExecuteResult>
      if (name === "sql_execute" && Array.isArray(args.tables) && args.tables.length > 0) {
        const { tables, ...rest } = args
        args = rest
        pending = fused(tables, rest, ctx)
      } else {
        if (name === "sql_execute") args = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "tables"))
        pending = Effect.runPromise(tool.execute(args, ctx))
      }
      active.add(pending)
      try {
        const result = await pending
        return record(name, result, args, request)
      } catch (error) {
        if (name === "answer_commit") messages.push(toolMessage(name, { status: "error", error: String(error) }))
        throw error
      } finally {
        active.delete(pending)
      }
    },
    async close() {
      shutdown.abort(new Error("MCP server closed"))
      await Promise.allSettled([...active])
      try {
        await closeScratch(sessionID)
      } finally {
        Precedence.releaseLocalSession(sessionID)
        if (!options.resultsDir) await rm(directory, { recursive: true, force: true })
      }
    },
  }
}
