// altimate_change start — trace-viewer plugin: session-trace history + open-in-browser + shared viewer server
//
// Re-homes the fork's trace-viewer TUI feature as a host-registered TuiPlugin
// (ADR docs/internal/2026-06-23-tui-fork-features-as-plugins-adr.md). Authored
// opencode-side so it can import `@/altimate/observability/**` directly; the
// upstream `packages/tui` files stay byte-for-byte upstream.
//
// Pre-merge sources: main:packages/opencode/src/cli/cmd/tui/app.tsx (trace blocks)
// and main:packages/opencode/src/cli/cmd/tui/component/dialog-trace-list.tsx.

import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "@opencode-ai/tui/builtins"
import { createMemo, createResource, onMount } from "solid-js"
import fsAsync from "fs/promises"
import open from "open"
import { Trace } from "@/altimate/observability/tracing"
import { renderTraceViewer } from "@/altimate/observability/viewer"
import { Log } from "@/util/log"
import { Locale } from "@/util/locale"

// ---------------------------------------------------------------------------
// Shared trace viewer server (one per process). Bun.serve is opencode-runtime
// bound, which is exactly why this lives in an opencode-side plugin file rather
// than in packages/tui. Lazily spun up on first open-in-browser.
// ---------------------------------------------------------------------------

let traceViewerServer: ReturnType<typeof Bun.serve> | undefined
let traceViewerTracesDir: string | undefined

function getTraceViewerUrl(sessionID: string, tracesDir?: string): string {
  // Always refresh the traces dir so subsequent calls with a new tracesDir
  // don't serve stale paths from the initial server creation.
  traceViewerTracesDir = Trace.getTracesDir(tracesDir)

  if (!traceViewerServer) {
    traceViewerServer = Bun.serve({
      port: 0, // random available port
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url)
        // Extract session ID from path: /view/<sessionID> or /api/<sessionID>
        const parts = url.pathname.split("/").filter(Boolean)
        const action = parts[0] // "view" or "api"
        const encodedSid = parts[1]
        if (!encodedSid) return new Response("Usage: /view/<sessionID>", { status: 400 })
        let sid: string
        try {
          sid = decodeURIComponent(encodedSid)
        } catch {
          return new Response("Invalid session ID encoding", { status: 400 })
        }

        const safeId = sid.replace(/[/\\.:]/g, "_")
        const traceFile = `${traceViewerTracesDir}/${safeId}.json`

        if (action === "api") {
          try {
            const content = await fsAsync.readFile(traceFile, "utf-8")
            return new Response(content, {
              headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
            })
          } catch {
            return new Response("{}", { status: 404 })
          }
        }

        // Serve HTML viewer
        try {
          const trace = JSON.parse(await fsAsync.readFile(traceFile, "utf-8"))
          const html = renderTraceViewer(trace, { live: true, apiPath: "/api/" + encodeURIComponent(sid) })
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
        } catch {
          return new Response("Trace not found. Try again after the agent responds.", { status: 404 })
        }
      },
    })
  }
  return `http://127.0.0.1:${traceViewerServer.port}/view/${encodeURIComponent(sessionID)}`
}

// ---------------------------------------------------------------------------
// Trace list dialog (re-authored against the plugin DialogSelect)
// ---------------------------------------------------------------------------

function cleanTitle(raw: unknown): string {
  if (!raw || typeof raw !== "string") return "(Untitled)"
  // Strip quotes, markdown headings, and take first non-empty line
  const stripped = raw.replace(/^["'`]+|["'`]+$/g, "").trim()
  const lines = stripped
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
  return lines.find((l) => l.length > 5) || lines[0] || stripped || "(Untitled)"
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}

function DialogTraceList(props: {
  api: TuiPluginApi
  currentSessionID?: string
  tracesDir?: string
  onSelect: (sessionID: string) => void
}) {
  const { DialogSelect } = props.api.ui
  const dialog = props.api.ui.dialog

  const [traces] = createResource(async () => {
    return Trace.listTraces(props.tracesDir)
  })

  const options = createMemo(() => {
    if (traces.state === "errored") {
      return [
        {
          title: "Failed to load traces",
          value: "__error__",
          description: `Check ${Trace.getTracesDir(props.tracesDir)}`,
        },
      ]
    }

    // Cap rendered items for TUI perf — DialogSelect creates reactive nodes
    // per item, so very large trace directories (thousands of entries) can
    // cause noticeable lag. Users with more than MAX_TUI_ITEMS traces should
    // use `altimate-code trace list --offset N` from the CLI.
    const MAX_TUI_ITEMS = 500
    const allItems = traces() ?? []
    const items = allItems.length > MAX_TUI_ITEMS ? allItems.slice(0, MAX_TUI_ITEMS) : allItems
    const truncated = allItems.length > MAX_TUI_ITEMS
    const today = new Date().toDateString()
    const result: Array<{ title: string; value: string; category: string; footer: string }> = []

    // Add current session placeholder if not found in disk traces
    if (props.currentSessionID && !items.some((t) => t.sessionId === props.currentSessionID)) {
      result.push({
        title: "Current session",
        value: props.currentSessionID,
        category: "Today",
        footer: Locale.time(Date.now()),
      })
    }

    result.push(
      ...items.map((item) => {
        const rawStartedAt = item.trace.startedAt
        const parsedDate =
          typeof rawStartedAt === "string" || typeof rawStartedAt === "number"
            ? new Date(rawStartedAt)
            : new Date(0)
        const date = Number.isNaN(parsedDate.getTime()) ? new Date(0) : parsedDate
        let category = date.toDateString()
        if (category === today) {
          category = "Today"
        }

        const metadata = item.trace.metadata ?? {}
        const rawTitle = metadata.prompt || metadata.title || item.sessionId
        const title = cleanTitle(rawTitle).slice(0, 80)

        const summary = item.trace.summary
        const status = summary?.status
        const statusLabel =
          status === "error" || status === "crashed"
            ? `[${status}] `
            : status === "running"
              ? "[running] "
              : ""

        const dur = Number.isFinite(summary?.duration) ? summary!.duration : 0
        const duration = formatDuration(dur)

        return {
          title: `${statusLabel}${title}`,
          value: item.sessionId,
          category,
          footer: `${duration}  ${Locale.time(date.getTime())}`,
        }
      }),
    )

    // Append truncation hint if we capped the list
    if (truncated) {
      result.push({
        title: `... ${allItems.length - MAX_TUI_ITEMS} more not shown`,
        value: "__truncated__",
        category: "Older",
        footer: `Showing ${MAX_TUI_ITEMS} of ${allItems.length} — use CLI --offset to navigate`,
      })
    }

    return result
  })

  onMount(() => {
    dialog.setSize("large")
  })

  const dialogTitle = () => (traces.state === "pending" ? "Traces (loading...)" : "Traces")

  return (
    <DialogSelect
      title={dialogTitle()}
      options={options()}
      current={props.currentSessionID}
      onSelect={(option) => {
        if (option.value === "__error__" || option.value === "__truncated__") {
          dialog.clear()
          return
        }
        props.onSelect(option.value as string)
        dialog.clear()
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const id = "altimate:trace-viewer"

const tui: TuiPlugin = async (api) => {
  // Load custom tracing dir from config (same as worker.ts / trace-consumer.ts).
  // Dynamic import keeps config failures from blocking plugin init.
  let tracesDir: string | undefined
  try {
    const { Config } = await import("@/config/config")
    const cfg = await Config.get()
    tracesDir = cfg.tracing?.dir
  } catch {
    // Config failure should not prevent the trace viewer from working.
  }

  async function openTraceInBrowser(sessionID: string) {
    try {
      // Check the trace file exists on disk before spinning up the browser.
      const safeId = sessionID.replace(/[/\\.:]/g, "_")
      const traceFilePath = `${Trace.getTracesDir(tracesDir)}/${safeId}.json`
      const exists = await fsAsync
        .access(traceFilePath)
        .then(() => true)
        .catch(() => false)
      if (!exists) {
        api.ui.toast({
          variant: "warning",
          message: "Trace not available yet — send a prompt first",
          duration: 4000,
        })
        return
      }
      const url = getTraceViewerUrl(sessionID, tracesDir)
      await open(url)
      api.ui.toast({ variant: "info", message: `Trace viewer: ${url}`, duration: 6000 })
    } catch (err) {
      Log.Default.error(`Failed to open trace viewer: ${err}`)
      api.ui.toast({
        variant: "warning",
        message: `Failed to open browser. Trace files: ${Trace.getTracesDir(tracesDir)}`,
        duration: 8000,
      })
    }
  }

  function showTraceList() {
    // TuiRouteCurrent's catch-all union member defeats discriminated narrowing on `name`,
    // so read params through a single shape cast.
    const params = (api.route.current as { params?: { sessionID?: string } }).params
    const currentSessionID = params?.sessionID
    api.ui.dialog.replace(() => (
      <DialogTraceList
        api={api}
        currentSessionID={currentSessionID}
        tracesDir={tracesDir}
        onSelect={openTraceInBrowser}
      />
    ))
  }

  api.keymap.registerLayer({
    commands: [
      {
        name: "trace.view",
        title: "View traces",
        category: "Debug",
        namespace: "palette",
        slashName: "trace",
        slashAliases: ["traces", "recap"],
        run() {
          showTraceList()
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("trace.palette", ["trace.view"]),
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

// altimate_change end
