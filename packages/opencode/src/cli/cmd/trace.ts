import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"
// altimate_change start — trace: session trace (recording/recap of agent sessions)
import { Trace, type TraceFile } from "../../altimate/observability/tracing"
// altimate_change end
import { renderTraceViewer } from "../../altimate/observability/viewer"
import { Config } from "../../config/config"
import fs from "fs/promises"
import path from "path"

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()

  if (diff < 60000) return "just now"
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`
  return d.toLocaleDateString()
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const hours = String(d.getHours()).padStart(2, "0")
  const mins = String(d.getMinutes()).padStart(2, "0")
  return `${month}/${day} ${hours}:${mins}`
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str
  return str.slice(0, len - 1) + "…"
}

// altimate_change start — trace: list session traces (recordings/recaps of agent sessions)
function listTraces(traces: Array<{ sessionId: string; trace: TraceFile }>, tracesDir?: string) {
  if (traces.length === 0) {
    UI.println("No traces found. Run a command with tracing enabled:")
    UI.println("  altimate-code run \"your prompt here\"")
    return
  }

  // Header
  const header = [
    "DATE".padEnd(13),
    "WHEN".padEnd(10),
    "STATUS".padEnd(10),
    "DURATION".padEnd(10),
    "TOKENS".padEnd(10),
    "COST".padEnd(10),
    "TOOLS".padEnd(7),
    "TITLE",
  ].join("")
  UI.println(UI.Style.TEXT_DIM + header + UI.Style.TEXT_NORMAL)

  for (const { sessionId, trace } of traces) {
    // Pad visible text first, then wrap with ANSI codes so padEnd counts correctly
    const statusText = trace.summary.status === "error" || trace.summary.status === "crashed"
      ? UI.Style.TEXT_DANGER_BOLD + (trace.summary.status).padEnd(10) + UI.Style.TEXT_NORMAL
      : trace.summary.status === "running"
        ? UI.Style.TEXT_WARNING_BOLD + "running".padEnd(10) + UI.Style.TEXT_NORMAL
        : "ok".padEnd(10)

    // Title: prefer metadata.title, fall back to truncated prompt, then session ID
    const displayTitle = trace.metadata.title
      || trace.metadata.prompt
      || sessionId

    const row = [
      formatDate(trace.startedAt).padEnd(13),
      formatTimestamp(trace.startedAt).padEnd(10),
      statusText,
      formatDuration(trace.summary.duration).padEnd(10),
      trace.summary.totalTokens.toLocaleString().padEnd(10),
      formatCost(trace.summary.totalCost).padEnd(10),
      String(trace.summary.totalToolCalls).padEnd(7),
      truncate(displayTitle, 50),
    ].join("")

    UI.println(row)
  }

  UI.empty()
  // altimate_change start — trace: session trace messages
  UI.println(UI.Style.TEXT_DIM + `${traces.length} trace(s) in ${Trace.getTracesDir(tracesDir)}` + UI.Style.TEXT_NORMAL)
  UI.println(UI.Style.TEXT_DIM + "View a trace: altimate-code trace view <session-id>" + UI.Style.TEXT_NORMAL)
  // altimate_change end
}
// altimate_change end


// altimate_change start — trace: session trace command (recording/recap of agent sessions)
export const TraceCommand = cmd({
  command: "trace [action] [id]",
  aliases: ["recap"],
  describe: "list and view session traces (recordings of agent sessions)",
  builder: (yargs: Argv) => {
    return yargs
      .positional("action", {
        describe: "action to perform",
        type: "string",
        choices: ["list", "view"] as const,
        default: "list",
      })
      .positional("id", {
        describe: "session ID for view action",
        type: "string",
      })
      // altimate_change start — trace: option descriptions
      .option("port", {
        type: "number",
        describe: "port for trace viewer server",
        default: 0,
      })
      .option("limit", {
        alias: ["n"],
        type: "number",
        describe: "number of traces to show",
        default: 20,
      })
      .option("live", {
        type: "boolean",
        describe: "auto-refresh the viewer as the trace updates (for in-progress sessions)",
        default: false,
      })
      // altimate_change end
  },
  // altimate_change start — trace: handler body
  handler: async (args) => {
    const action = args.action || "list"
    const cfg = await Config.get().catch(() => ({} as Record<string, any>))
    const tracesDir = (cfg as any).tracing?.dir as string | undefined

    if (action === "list") {
      const traces = await Trace.listTraces(tracesDir)
      listTraces(traces.slice(0, args.limit || 20), tracesDir)
      return
    }

    if (action === "view") {
      if (!args.id) {
        UI.error("Usage: altimate-code trace view <session-id>")
        process.exit(1)
      }

      // Support partial session ID matching
      const traces = await Trace.listTraces(tracesDir)
      const match = traces.find(
        (t) => t.sessionId === args.id || t.sessionId.startsWith(args.id!) || t.file.startsWith(args.id!),
      )

      if (!match) {
        UI.error(`Trace not found: ${args.id}`)
        UI.println("Available traces:")
        listTraces(traces.slice(0, 10), tracesDir)
        process.exit(1)
      }

      const tracePath = path.join(Trace.getTracesDir(tracesDir), match.file)
      const port = args.port || 0
      const live = args.live || false

      const server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        async fetch(req) {
          const url = new URL(req.url)

          // /api/trace — serves latest trace JSON (for live polling)
          if (url.pathname === "/api/trace") {
            try {
              const content = await fs.readFile(tracePath, "utf-8")
              return new Response(content, {
                headers: {
                  "Content-Type": "application/json",
                  "Cache-Control": "no-cache",
                },
              })
            } catch {
              return new Response("{}", { status: 404 })
            }
          }

          // / — serves the HTML viewer (new multi-view renderer)
          const trace = JSON.parse(await fs.readFile(tracePath, "utf-8").catch(() => "{}")) as TraceFile
          const html = renderTraceViewer(trace, { live, apiPath: "/api/trace" })
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        },
      })

      const url = `http://localhost:${server.port}`
      // altimate_change start — trace: viewer message
      UI.println(`Trace viewer: ${url}`)
      // altimate_change end
      if (live) {
        UI.println(UI.Style.TEXT_DIM + "Live mode: auto-refreshing every 2s" + UI.Style.TEXT_NORMAL)
      }
      UI.println(UI.Style.TEXT_DIM + "Press Ctrl+C to stop" + UI.Style.TEXT_NORMAL)

      // Try to open browser
      try {
        const openArgs = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", url] : ["xdg-open", url]
        Bun.spawn(openArgs, { stdout: "ignore", stderr: "ignore" })
      } catch {
        // User can open manually
      }

      // Graceful shutdown on interrupt
      const shutdown = async () => {
        try { await server.stop() } catch {}
        process.exit(0)
      }
      process.on("SIGINT", shutdown)
      process.on("SIGTERM", shutdown)

      // Keep server alive until interrupted
      await new Promise(() => {})
    }
  },
  // altimate_change end
})
// altimate_change end
