// altimate_change start — recap: session recap history dialog
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { createMemo, createResource, onMount } from "solid-js"
import { Recap } from "@/altimate/observability/tracing"
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

export function DialogRecapList(props: {
  currentSessionID?: string
  tracesDir?: string
  onSelect: (sessionID: string) => void
}) {
  const dialog = useDialog()

  // altimate_change start — recap: use Recap.listTraces
  const [traces] = createResource(async () => {
    return Recap.listTraces(props.tracesDir)
  })
  // altimate_change end

  // altimate_change start — recap: renamed text and Recap references
  const options = createMemo(() => {
    if (traces.state === "errored") {
      return [
        {
          title: "Failed to load recaps",
          value: "__error__",
          description: `Check ${Recap.getTracesDir(props.tracesDir)}`,
        },
      ]
    }
    // altimate_change end

    const items = traces() ?? []
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

    result.push(...items.slice(0, 50).map((item) => {
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

    return result
  })

  onMount(() => {
    dialog.setSize("large")
  })

  // altimate_change start — recap: renamed title text
  const dialogTitle = traces.state === "pending" ? "Recaps (loading...)" : "Recaps"
  // altimate_change end

  return (
    <DialogSelect
      title={dialogTitle}
      options={options()}
      current={props.currentSessionID}
      onSelect={(option) => {
        if (option.value === "__error__") {
          dialog.clear()
          return
        }
        props.onSelect(option.value)
        dialog.clear()
      }}
    />
  )
}

// altimate_change start — recap: backward-compat alias
/** @deprecated Use DialogRecapList instead */
export const DialogTraceList = DialogRecapList
// altimate_change end
// altimate_change end
