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
import { AnswerCommitTool } from "../tools/answer-commit"
import * as Precedence from "../workspace/precedence"
import { closeScratch } from "../native/connections/scratch"
import type { SessionID, MessageID } from "@/session/schema"

export const descriptions: Record<string, string> = {
  warehouse_list: "List configured warehouse connections and their database types.",
  schema_inspect: "List tables/collections when table is omitted or empty; otherwise inspect one table, with optional sample values.",
  sql_execute:
    "Execute SQL against a connected warehouse and return rows. Source writes require the server's --allow-write option.",
  sql_check: "Run a read-only SQL data quality check against a connected warehouse.",
  sql_materialize: "Copy a read-only source query into a session-local scratch table for further analysis.",
  answer_commit:
    "Finish a data question. Call this last, with one field (or rows column) per item the request asks for and `asked` listing those items in order; the call is rejected when an asked item has no value of its own or a number was not seen in query output. Reply with exactly the returned FINAL ANSWER text.",
}

// The native tool caps `basis` at 400 characters; over the MCP boundary the text is trimmed instead of rejected.
const BASIS_LIMIT = 400
const MCP_ONLY_TOOLS = new Set(["answer_commit"])

/** Session-level record the native commit checks read: tool outputs and rejections of the current turn. */
type TurnMessage = Tool.Context["messages"][number]
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
          if (tool.jsonSchema && info.id === "answer_commit") tool.jsonSchema = relaxBasis(tool.jsonSchema)
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
  const record = (name: string, result: Tool.ExecuteResult) => {
    if (name !== "answer_commit") {
      if (result.status !== "error") messages.push(toolMessage(name, { status: "completed", output: result.output }))
      return result
    }
    if (result.status === "error") {
      messages.push(toolMessage(name, { status: "error", error: result.output }))
      return result
    }
    messages.push(userMessage())
    return { ...result, output: `FINAL ANSWER: ${result.metadata.committed_text ?? result.output}` }
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
      const pending = Effect.runPromise(tool.execute(args, ctx))
      active.add(pending)
      try {
        const result = await pending
        return record(name, result)
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
