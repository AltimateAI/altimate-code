// altimate_change start — trace: session trace history dialog
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { createMemo, createResource, onMount } from "solid-js"
import { Trace } from "@/altimate/observability/tracing"
import { Locale } from "@/util/locale"

function cleanTitle(raw: unknown): string {
  if (!raw || typeof raw !== "string") return "(Untitled)"
  // Strip quotes, markdown headings, and take first non-empty line
  const stripped = raw.replace(/^["'`]+|["'`]+$/g, "").trim()
  const lines = stripped.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).filter(Boolean)
  return lines.find((l) => l.length > 5) || lines[0] || stripped || "(Untitled)"
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}

export function DialogTraceList(props: {
  currentSessionID?: string
  tracesDir?: string
  onSelect: (sessionID: string) => void
}) {
  const dialog = useDialog()

  // altimate_change start — trace: use Trace.listTraces
  const [traces] = createResource(async () => {
    return Trace.listTraces(props.tracesDir)
  })
  // altimate_change end

  // altimate_change start — trace: trace list options
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
    // altimate_change end

    // Cap rendered items for TUI perf — DialogSelect creates reactive
    // nodes per item via <For>, so very large trace directories
    // (thousands of entries) can cause noticeable lag. Users with more
    // than MAX_TUI_ITEMS traces should use `altimate-code trace list
    // --offset N` from the CLI to navigate the full set.
    const MAX_TUI_ITEMS = 500
    const allItems = traces() ?? []
    const items =
      allItems.length > MAX_TUI_ITEMS ? allItems.slice(0, MAX_TUI_ITEMS) : allItems
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

    result.push(...items.map((item) => {
        const rawStartedAt = item.trace.startedAt
        const parsedDate = typeof rawStartedAt === "string" || typeof rawStartedAt === "number"
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
      }))

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

  // altimate_change start — trace: dialog title
  const dialogTitle = traces.state === "pending" ? "Traces (loading...)" : "Traces"
  // altimate_change end

  return (
    <DialogSelect
      title={dialogTitle}
      options={options()}
      current={props.currentSessionID}
      onSelect={(option) => {
        if (option.value === "__error__" || option.value === "__truncated__") {
          dialog.clear()
          return
        }
        props.onSelect(option.value)
        dialog.clear()
      }}
    />
  )
}

// altimate_change end
