import path from "node:path"
import { Global } from "@/global"
import { createAdapter, descriptions, resultFailed } from "../mcp-server/adapter"

export interface ToolResult {
  status: "ok" | "error"
  title: string
  output: string
  metadata: Record<string, unknown>
}

export interface ListedTool {
  id: string
  description: string
  inputSchema: unknown
}

export interface RunnerOptions {
  /** Also expose the linked-workspace tools, as `mcp serve --workspace-tools` does. */
  workspaceTools?: boolean
}

export interface Runner {
  list(): Promise<ListedTool[]>
  run(name: string, args: unknown, options?: { allowWrite?: boolean; signal?: AbortSignal }): Promise<ToolResult>
  close(): Promise<void>
}

function failure(title: string, output: string): ToolResult {
  return { status: "error", title, output, metadata: {} }
}

/** Spilled results outlive the one-shot process that wrote them, so the CLI keeps them in the per-user state directory. */
export function resultsDirectory(): string {
  return path.join(Global.Path.state, "tool-results")
}

type WorkspaceAdapter = Awaited<ReturnType<(typeof import("../mcp-server/workspace"))["createWorkspaceAdapter"]>>

/**
 * The `tool` CLI front door. Tools run through the same adapter `mcp serve` uses (compact schemas, `sql_execute`
 * `tables`, `query_from` chaining, result spill, read-only enforcement, `answer_commit` request), here with the whole
 * allow-list. Must run inside a bootstrapped project instance so connections and config resolve for that directory.
 * One adapter session is shared by every call, so `scratch` tables survive between calls while the runner lives.
 */
export async function createRunner(options: RunnerOptions = {}): Promise<Runner> {
  const adapter = await createAdapter({ allTools: true, cli: true, resultsDir: resultsDirectory() })
  let workspace: WorkspaceAdapter | undefined
  try {
    if (options.workspaceTools) workspace = await (await import("../mcp-server/workspace")).createWorkspaceAdapter(process.cwd())
  } catch (error) {
    await adapter.close()
    throw error
  }
  const workspaceNames = new Set(workspace?.tools.map((tool) => tool.name))

  return {
    async list() {
      const listed: ListedTool[] = [...adapter.tools].map(([id, tool]) => ({
        id,
        description: descriptions[id] ?? tool.description,
        inputSchema: tool.jsonSchema ?? {},
      }))
      for (const tool of workspace?.tools ?? []) listed.push({ id: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema })
      return listed.sort((a, b) => a.id.localeCompare(b.id))
    },
    async run(name, args, call = {}) {
      if (!adapter.tools.has(name) && !workspaceNames.has(name))
        return failure("Unknown tool", `Unknown tool: ${name}. Run \`altimate-code tool list\` to see the available tools.`)
      if (typeof args !== "object" || args === null || Array.isArray(args))
        return failure("Invalid arguments", "Tool arguments must be a JSON object.")
      const signal = call.signal ?? new AbortController().signal
      try {
        if (workspace && workspaceNames.has(name)) {
          const answer = await workspace.execute(name, args as Record<string, unknown>, signal)
          const content = (answer as { content?: { type: string; text?: string }[] }).content ?? []
          const output = content.map((part) => part.text ?? "").join("\n")
          const isError = (answer as { isError?: boolean }).isError === true
          return { status: isError ? "error" : "ok", title: name, output, metadata: {} }
        }
        const result = await adapter.execute(name, args as Record<string, unknown>, signal, { allowWrite: call.allowWrite === true })
        return {
          status: resultFailed(result) ? "error" : "ok",
          title: result.title,
          output: result.output,
          metadata: result.metadata ?? {},
        }
      } catch (error) {
        return failure(`${name} failed`, error instanceof Error ? error.message : String(error))
      }
    },
    async close() {
      try {
        await workspace?.close()
      } finally {
        await adapter.close()
      }
    },
  }
}
