import type { TraceFile } from "../types"

export interface TraceSummaryReport {
  sessionId: string
  title: string
  model: string
  agent: string
  status: string
  duration: string
  durationMs: number
  totalTokens: number
  tokensBreakdown: { input: number; output: number; cacheRead: number }
  totalCost: number
  toolCalls: number
  generations: number
  narrative: string
  topTools: Array<{ name: string; count: number; avgDuration: number }>
  loops: Array<{ tool: string; count: number }>
  spanKindDistribution: Record<string, number>
  avgGenerationLatency: number
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}m${s ? s + "s" : ""}`
}

export function summarizeTrace(trace: TraceFile): TraceSummaryReport {
  const genSpans = trace.spans.filter(
    (s) => s.kind === "generation" && s.startTime && s.endTime,
  )
  const genLatencies = genSpans.map((s) => s.endTime! - s.startTime!)
  const avgGenLatency = genLatencies.length
    ? genLatencies.reduce((a, b) => a + b, 0) / genLatencies.length
    : 0

  const kindDist: Record<string, number> = {}
  for (const s of trace.spans) {
    kindDist[s.kind] = (kindDist[s.kind] ?? 0) + 1
  }

  const topTools = (trace.summary.topTools ?? []).map((t) => ({
    name: t.name,
    count: t.count,
    avgDuration: t.count ? t.totalDuration / t.count : 0,
  }))

  return {
    sessionId: trace.sessionId,
    title: trace.metadata.title ?? trace.sessionId,
    model: trace.metadata.model ?? "unknown",
    agent: trace.metadata.agent ?? "default",
    status: trace.summary.status,
    duration: fmtDuration(trace.summary.duration),
    durationMs: trace.summary.duration,
    totalTokens: trace.summary.totalTokens,
    tokensBreakdown: {
      input: trace.summary.tokens.input,
      output: trace.summary.tokens.output,
      cacheRead: trace.summary.tokens.cacheRead,
    },
    totalCost: trace.summary.totalCost,
    toolCalls: trace.summary.totalToolCalls,
    generations: trace.summary.totalGenerations,
    narrative: trace.summary.narrative ?? "No narrative available.",
    topTools,
    loops: (trace.summary.loops ?? []).map((l) => ({ tool: l.tool, count: l.count })),
    spanKindDistribution: kindDist,
    avgGenerationLatency: avgGenLatency,
  }
}

export function summarizeTraces(traces: TraceFile[]): {
  count: number
  totalTokens: number
  totalCost: number
  totalDuration: number
  avgDuration: number
  avgTokens: number
  avgCost: number
  successRate: number
  summaries: TraceSummaryReport[]
} {
  const summaries = traces.map(summarizeTrace)
  const totalTokens = traces.reduce((s, t) => s + t.summary.totalTokens, 0)
  const totalCost = traces.reduce((s, t) => s + t.summary.totalCost, 0)
  const totalDuration = traces.reduce((s, t) => s + t.summary.duration, 0)
  const completed = traces.filter((t) => t.summary.status === "completed").length

  return {
    count: traces.length,
    totalTokens,
    totalCost,
    totalDuration,
    avgDuration: traces.length ? totalDuration / traces.length : 0,
    avgTokens: traces.length ? totalTokens / traces.length : 0,
    avgCost: traces.length ? totalCost / traces.length : 0,
    successRate: traces.length ? completed / traces.length : 0,
    summaries,
  }
}

export function printTraceSummary(report: TraceSummaryReport): void {
  console.log("")
  console.log(`  Session: "${report.title}"`)
  console.log("  " + "─".repeat(50))
  console.log(`  Duration:     ${report.duration}`)
  console.log(`  Model:        ${report.model}`)
  console.log(`  Agent:        ${report.agent}`)
  console.log(`  Status:       ${report.status}`)
  console.log(`  Tokens:       ${report.totalTokens.toLocaleString()} (in: ${report.tokensBreakdown.input.toLocaleString()} / out: ${report.tokensBreakdown.output.toLocaleString()}${report.tokensBreakdown.cacheRead ? ` / cache: ${report.tokensBreakdown.cacheRead.toLocaleString()}` : ""})`)
  console.log(`  Cost:         $${report.totalCost.toFixed(4)}`)
  console.log(`  Tools:        ${report.topTools.map((t) => `${t.name}(${t.count})`).join(" ") || "none"}`)
  console.log(`  Generations:  ${report.generations}`)
  if (report.loops.length) {
    console.log(`  Loops:        ${report.loops.map((l) => `${l.tool} (${l.count}x)`).join(", ")}`)
  }
  console.log("")
  if (report.narrative) {
    console.log(`  ${report.narrative}`)
    console.log("")
  }
}
