import { FSUtil } from "@opencode-ai/core/fs-util"
import { NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { mkdtemp, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { outputLimits } from "./output-settings"
import { WarehouseListTool } from "../tools/warehouse-list"
import { SchemaInspectTool } from "../tools/schema-inspect"
import { SqlExecuteTool } from "../tools/sql-execute"
import { SqlCheckTool } from "../tools/sql-check"
import { SqlMaterializeTool } from "../tools/sql-materialize"
import { AnswerCommitTool, renderAnswer } from "../tools/answer-commit"
import { requestedItemCount } from "../tools/answer-commit-conjunction"
import * as Precedence from "../workspace/precedence"
import { closeScratch } from "../native/connections/scratch"
import type { SessionID, MessageID } from "@/session/schema"

export const descriptions: Record<string, string> = {
  warehouse_list: "List connections; for local databases also tables, columns and a sample row.",
  schema_inspect: "List tables when table is omitted; otherwise one table's columns and value profile.",
  sql_execute:
    "Run SQL and return rows. Put independent queries in one call with `queries`. Source writes need --allow-write.",
  sql_check: "Read-only data check: fanout, keys, grain, nulls or coverage.",
  sql_materialize: "Store a read-only query's rows as a scratch table, to join across connections.",
  answer_commit:
    "Finish a data question; call last, then reply with exactly its FINAL ANSWER text. Use one of fields, rows or unresolved, with a field (or rows column) per asked item, named after it. Numbers may be your own computation; exact decimals as strings.",
}

/**
 * Short MCP property descriptions, keyed by property path (`a.b` nests, `a[]` is an array's items).
 * Every tool definition is re-sent on each model request, so the advertised schema keeps only what a
 * caller needs to choose and fill a property; `null` drops the description, `DROP` the property.
 */
const DROP = Symbol("drop")
const PROPERTY_DESCRIPTIONS: Record<string, Record<string, string | null | typeof DROP>> = {
  schema_inspect: {
    table: "Table, optionally schema-qualified; omit to list tables",
    schema_name: null,
    warehouse: null,
    values: "Include the value profile (default true)",
  },
  sql_execute: {
    query: "SQL, or a MongoDB JSON command",
    queries: "Up to 8 independent read-only queries; each gets its own labeled result",
    "queries[].label": "Default q1, q2, ...",
    "queries[].query": null,
    "queries[].warehouse": "Default: warehouse",
    query_from: "Run the SQL string this read-only SELECT returns, without copying it",
    "query_from.warehouse": null,
    "query_from.sql": "SELECT returning one row with one SQL string column",
    warehouse: null,
    limit: "Max rows (default 100, max 10000)",
    full_text_columns: "Columns whose full text to prioritize (at most 20 rows; all rows are saved)",
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
    join: null,
    left_col: "keys: left column",
    right_col: "keys: right column",
    left_warehouse: DROP,
    right_warehouse: DROP,
    query_timeout_ms: null,
  },
  sql_materialize: {
    source_warehouse: "Warehouse to read, or scratch",
    sql: "Read-only SELECT; every returned row is stored",
    target_table: "New scratch table: letters, digits, underscores",
    mode: "create (default), replace or append",
    max_rows: "Row cap (default 2000000)",
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
    (fields > 0 && fields >= requestedItemCount(typeof request === "string" ? request : ""))
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

export async function createAdapter(options: { allowWrite?: boolean } = {}) {
  const limits = await outputLimits()
  const directory = await mkdtemp(path.join(tmpdir(), "altimate-code-mcp-results-"))
  await chmod(directory, 0o700)
  const sessionID = `mcp-${randomUUID()}` as SessionID
  Precedence.bindLocalSession(sessionID)
  const tools = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = new Map<string, Tool.Def>()
        for (const source of [WarehouseListTool, SchemaInspectTool, SqlExecuteTool, SqlCheckTool, SqlMaterializeTool, AnswerCommitTool]) {
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
          result.set(info.id, tool)
        }
        return result
      }).pipe(Effect.provide(services(directory, limits))),
    ),
  ).catch(async (error) => {
    Precedence.releaseLocalSession(sessionID)
    await rm(directory, { recursive: true, force: true })
    throw error
  })

  const messages: TurnMessage[] = [userMessage()]
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
    return { ...result, output: finalAnswerText(args, result.metadata.committed_text ?? result.output, request) }
  }
  return {
    tools,
    async execute(name: string, args: Record<string, unknown>, signal: AbortSignal) {
      signal = AbortSignal.any([signal, shutdown.signal])
      signal.throwIfAborted()
      const tool = tools.get(name)
      if (!tool) throw new Error(`Unknown tool: ${name}`)
      const ctx: Tool.Context = {
        sessionID,
        messageID: `mcp-${randomUUID()}` as MessageID,
        agent: "analyst",
        abort: signal,
        extra: { mcpClient: true, forceReadOnly: !options.allowWrite },
        messages,
        metadata: () => Effect.void,
        // Fail closed for new permission kinds. sql_execute is the validated source-read permission.
        ask: ({ permission }) =>
          permission === "sql_execute" ||
          permission === "schema_inspect" ||
          permission === "answer_commit" || options.allowWrite
            ? Effect.void
            : Effect.die(new Error(`Permission denied: ${permission}. Restart with --allow-write to enable writes.`)),
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
      const pending = Effect.runPromise(tool.execute(args, ctx))
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
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}
