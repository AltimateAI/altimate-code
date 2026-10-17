import { Effect, Layer } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Agent } from "@/agent/agent"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import * as TruncateCore from "@/tool/truncate-core"
import { WarehouseListTool } from "../tools/warehouse-list"
import { SchemaInspectTool } from "../tools/schema-inspect"
import { SqlExecuteTool } from "../tools/sql-execute"
import { SqlCheckTool } from "../tools/sql-check"
import { SqlMaterializeTool } from "../tools/sql-materialize"
import * as Precedence from "../workspace/precedence"
import { closeScratch } from "../native/connections/scratch"
import type { SessionID, MessageID } from "@/session/schema"

export const descriptions: Record<string, string> = {
  warehouse_list: "List configured warehouse connections and their database types.",
  schema_inspect: "Inspect tables and columns in a connected warehouse, with optional sample values.",
  sql_execute:
    "Execute SQL against a connected warehouse and return rows. Source writes require the server's --allow-write option.",
  sql_check: "Run a read-only SQL data quality check against a connected warehouse.",
  sql_materialize: "Copy a read-only source query into a session-local scratch table for further analysis.",
}

// These services intentionally have no agent runtime, configuration loading, or provider dependencies.
const analyst = { name: "analyst", mode: "primary", permission: [], options: {} } as Agent.Info
const truncation: Truncate.Interface = {
  cleanup: () => Effect.void,
  limits: () => Effect.succeed({ maxLines: TruncateCore.MAX_LINES, maxBytes: TruncateCore.MAX_BYTES }),
  write: (text) =>
    Effect.promise(async () => {
      const directory = path.join(tmpdir(), "altimate-code-mcp-results")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const file = path.join(directory, `${randomUUID()}.txt`)
      await writeFile(file, text, { mode: 0o600 })
      return file
    }),
  output: (text, options = {}) =>
    Effect.gen(function* () {
      const maxLines = options.maxLines ?? TruncateCore.MAX_LINES
      const maxBytes = options.maxBytes ?? TruncateCore.MAX_BYTES
      const lines = text.split("\n")
      const bytes = Buffer.byteLength(text)
      if (TruncateCore.fits(lines, bytes, maxLines, maxBytes)) return { content: text, truncated: false as const }
      const direction = options.direction ?? TruncateCore.DEFAULT_DIRECTION
      const preview = TruncateCore.preview(lines, bytes, {
        maxLines,
        maxBytes,
        direction,
        headRatio: options.headRatio ?? TruncateCore.DEFAULT_HEAD_RATIO,
      })
      const file = yield* truncation.write(text)
      return {
        content: TruncateCore.assemble(
          preview,
          `Full output saved to: ${file}\nOpen this path with any file reader to inspect the remaining output.`,
          direction,
        ),
        truncated: true as const,
        outputPath: file,
      }
    }),
}

const services = Layer.mergeAll(
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
  Layer.succeed(Truncate.Service, truncation),
)

export async function createAdapter(options: { allowWrite?: boolean } = {}) {
  const sessionID = `mcp-${randomUUID()}` as SessionID
  Precedence.bindLocalSession(sessionID)
  const tools = await Effect.runPromise(
    Effect.gen(function* () {
      const result = new Map<string, Tool.Def>()
      for (const source of [WarehouseListTool, SchemaInspectTool, SqlExecuteTool, SqlCheckTool, SqlMaterializeTool]) {
        const info = yield* source
        result.set(info.id, yield* Tool.init(info, { agent: analyst }))
      }
      return result
    }).pipe(Effect.provide(services)),
  )

  return {
    tools,
    async execute(name: string, args: Record<string, unknown>, signal: AbortSignal) {
      signal.throwIfAborted()
      const tool = tools.get(name)
      if (!tool) throw new Error(`Unknown tool: ${name}`)
      const ctx: Tool.Context = {
        sessionID,
        messageID: `mcp-${randomUUID()}` as MessageID,
        agent: "analyst",
        abort: signal,
        extra: { mcpClient: true },
        messages: [],
        metadata: () => Effect.void,
        // Fail closed for new permission kinds. sql_execute is the validated source-read permission.
        ask: ({ permission }) =>
          permission === "sql_execute" || permission === "schema_inspect" || options.allowWrite
            ? Effect.void
            : Effect.die(new Error(`Permission denied: ${permission}. Restart with --allow-write to enable writes.`)),
      }
      return Effect.runPromise(tool.execute(args, ctx))
    },
    async close() {
      await closeScratch(sessionID)
      Precedence.releaseLocalSession(sessionID)
    },
  }
}
