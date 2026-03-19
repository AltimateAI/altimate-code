// altimate_change start - trace history dialog
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { createMemo, createResource, onMount, Show } from "solid-js"
import { Tracer } from "@/altimate/observability/tracing"
import { Locale } from "@/util/locale"

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

export function DialogTraceList(props: {
  currentSessionID?: string
  onSelect: (sessionID: string) => void
}) {
  const dialog = useDialog()

  const [traces] = createResource(async () => {
    return Tracer.listTraces()
  })

  const options = createMemo(() => {
    if (traces.state === "errored") {
      return [
        {
          title: "Failed to load traces",
          value: "__error__",
          description: `Check ${Tracer.getTracesDir()}`,
          disabled: true,
        },
      ]
    }

    const items = traces() ?? []
    const today = new Date().toDateString()

    return items.slice(0, 50).map((item) => {
      const date = new Date(item.trace.startedAt)
      let category = date.toDateString()
      if (category === today) {
        category = "Today"
      }

      const title = item.trace.metadata?.title || item.trace.metadata?.prompt?.slice(0, 60) || item.sessionId

      const summary = item.trace.summary
      const status = summary?.status
      const statusLabel =
        status === "error" || status === "crashed"
          ? `[${status}] `
          : status === "running"
            ? "[running] "
            : ""

      const duration = formatDuration(summary?.duration ?? 0)
      const cost = formatCost(summary?.totalCost ?? 0)
      const tokens = (summary?.totalTokens ?? 0).toLocaleString()
      const tools = summary?.totalToolCalls ?? 0

      return {
        title: `${statusLabel}${title}`,
        value: item.sessionId,
        category,
        footer: `${Locale.time(date.getTime())} · ${duration} · ${tokens} tokens · ${cost} · ${tools} tools`,
      }
    })
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title={traces.state === "pending" ? "Trace History (loading...)" : "Trace History"}
      options={options()}
      current={props.currentSessionID}
      onSelect={(option) => {
        if (option.value === "__error__") return
        props.onSelect(option.value)
        dialog.clear()
      }}
    />
  )
}
// altimate_change end
