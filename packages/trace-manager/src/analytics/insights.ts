import type { TraceFile } from "../types"

export type InsightSeverity = "critical" | "warning" | "info" | "positive"

export interface Insight {
  id: string
  severity: InsightSeverity
  category: string
  title: string
  description: string
  evidence: string[]
  recommendation: string
  affectedSessions: string[]
  metric?: { label: string; value: string; trend?: "up" | "down" | "flat" }
}

export function generateInsights(traces: TraceFile[]): Insight[] {
  if (!traces.length) return []
  const insights: Insight[] = []
  let idSeq = 0
  const mkId = () => `insight-${++idSeq}`

  // ── Cost insights ──
  const totalCost = traces.reduce((s, t) => s + t.summary.totalCost, 0)
  const costByModel: Record<string, { cost: number; sessions: string[] }> = {}
  for (const t of traces) {
    const m = t.metadata.model ?? "unknown"
    if (!costByModel[m]) costByModel[m] = { cost: 0, sessions: [] }
    costByModel[m].cost += t.summary.totalCost
    costByModel[m].sessions.push(t.sessionId)
  }
  const modelEntries = Object.entries(costByModel).sort((a, b) => b[1].cost - a[1].cost)
  if (modelEntries.length > 1 && modelEntries[0][1].cost > totalCost * 0.8) {
    insights.push({
      id: mkId(), severity: "warning", category: "Cost",
      title: `${modelEntries[0][0].split("/").pop()} accounts for ${((modelEntries[0][1].cost / (totalCost || 1)) * 100).toFixed(0)}% of all cost`,
      description: "A single model is dominating spend. Cheaper models may handle simpler tasks.",
      evidence: [`$${modelEntries[0][1].cost.toFixed(4)} out of $${totalCost.toFixed(4)} total`],
      recommendation: "Route simple tasks (file reads, small edits) to cheaper models. Reserve expensive models for complex reasoning.",
      affectedSessions: modelEntries[0][1].sessions,
      metric: { label: "Model share", value: `${((modelEntries[0][1].cost / (totalCost || 1)) * 100).toFixed(0)}%`, trend: "up" },
    })
  }

  // ── Token waste: high input with low output ──
  const highInputLowOutput = traces.filter(
    (t) => t.summary.tokens.input > 50000 && t.summary.tokens.output < 500,
  )
  if (highInputLowOutput.length >= 2) {
    insights.push({
      id: mkId(), severity: "warning", category: "Efficiency",
      title: `${highInputLowOutput.length} sessions consumed 50K+ input tokens but produced <500 output tokens`,
      description: "These sessions sent large context to the model but got minimal output — likely context is being wasted.",
      evidence: highInputLowOutput.map((t) => `"${t.metadata.title ?? t.sessionId}": ${t.summary.tokens.input.toLocaleString()} in → ${t.summary.tokens.output.toLocaleString()} out`),
      recommendation: "Check if full file contents are being sent when only specific sections are needed. Consider using grep/search before read.",
      affectedSessions: highInputLowOutput.map((t) => t.sessionId),
      metric: { label: "Wasted context", value: `${highInputLowOutput.length} sessions` },
    })
  }

  // ── Doom loops ──
  const withLoops = traces.filter((t) => t.summary.loops && t.summary.loops.length > 0)
  if (withLoops.length > 0) {
    const allLoops = withLoops.flatMap((t) => t.summary.loops ?? [])
    const loopTools: Record<string, number> = {}
    for (const l of allLoops) loopTools[l.tool] = (loopTools[l.tool] ?? 0) + l.count
    const topLoopTool = Object.entries(loopTools).sort((a, b) => b[1] - a[1])[0]

    insights.push({
      id: mkId(), severity: "critical", category: "Reliability",
      title: `${withLoops.length} session(s) entered doom loops — ${topLoopTool?.[0] ?? "unknown"} repeated ${topLoopTool?.[1] ?? 0} times`,
      description: "The agent got stuck calling the same tool with the same input repeatedly. This wastes tokens and time.",
      evidence: withLoops.map((t) => `"${t.metadata.title ?? t.sessionId}": ${(t.summary.loops ?? []).map((l) => `${l.tool}(${l.count}x)`).join(", ")}`),
      recommendation: "Add loop detection guardrails. If a tool fails 3+ times with the same input, break the loop and try a different approach.",
      affectedSessions: withLoops.map((t) => t.sessionId),
      metric: { label: "Loop rate", value: `${((withLoops.length / traces.length) * 100).toFixed(0)}%`, trend: "up" },
    })
  }

  // ── Tool errors ──
  const toolErrors: Record<string, { count: number; sessions: Set<string> }> = {}
  for (const t of traces) {
    for (const s of t.spans) {
      if (s.kind === "tool" && s.status === "error") {
        if (!toolErrors[s.name]) toolErrors[s.name] = { count: 0, sessions: new Set() }
        toolErrors[s.name].count++
        toolErrors[s.name].sessions.add(t.sessionId)
      }
    }
  }
  const errorEntries = Object.entries(toolErrors).sort((a, b) => b[1].count - a[1].count)
  if (errorEntries.length > 0) {
    const [toolName, data] = errorEntries[0]
    insights.push({
      id: mkId(), severity: data.count >= 5 ? "critical" : "warning", category: "Reliability",
      title: `"${toolName}" failed ${data.count} times across ${data.sessions.size} session(s)`,
      description: `The most failing tool is "${toolName}". Frequent tool failures degrade user experience and waste tokens on retries.`,
      evidence: errorEntries.slice(0, 5).map(([n, d]) => `${n}: ${d.count} failures in ${d.sessions.size} sessions`),
      recommendation: `Investigate why "${toolName}" fails. Common causes: permission denied, file not found, syntax errors in generated code.`,
      affectedSessions: [...data.sessions],
      metric: { label: "Top failing tool", value: `${toolName} (${data.count}x)` },
    })
  }

  // ── Long sessions ──
  const longSessions = traces.filter((t) => t.summary.duration > 600_000) // >10 min
  if (longSessions.length > 0) {
    const avgDur = traces.reduce((s, t) => s + t.summary.duration, 0) / traces.length
    const longAvgDur = longSessions.reduce((s, t) => s + t.summary.duration, 0) / longSessions.length
    insights.push({
      id: mkId(), severity: longSessions.length > traces.length * 0.3 ? "warning" : "info", category: "Performance",
      title: `${longSessions.length} session(s) exceeded 10 minutes (avg ${fmtDur(longAvgDur)})`,
      description: `These sessions are significantly longer than the overall average of ${fmtDur(avgDur)}. Long sessions may indicate complex tasks or inefficient tool usage.`,
      evidence: longSessions.slice(0, 5).map((t) => `"${t.metadata.title ?? t.sessionId}": ${fmtDur(t.summary.duration)}, ${t.summary.totalToolCalls} tool calls`),
      recommendation: "Break complex tasks into smaller, focused sessions. Check if the agent is exploring unnecessary paths.",
      affectedSessions: longSessions.map((t) => t.sessionId),
      metric: { label: "Long sessions", value: `${longSessions.length}/${traces.length}` },
    })
  }

  // ── Tool usage imbalance ──
  const toolCounts: Record<string, number> = {}
  for (const t of traces) for (const tt of t.summary.topTools ?? []) toolCounts[tt.name] = (toolCounts[tt.name] ?? 0) + tt.count
  const totalToolCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0)
  const sortedTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])
  if (sortedTools.length > 3 && sortedTools[0][1] > totalToolCalls * 0.5) {
    insights.push({
      id: mkId(), severity: "info", category: "Patterns",
      title: `"${sortedTools[0][0]}" dominates tool usage at ${((sortedTools[0][1] / totalToolCalls) * 100).toFixed(0)}% of all calls`,
      description: "A single tool accounts for most activity. This might be normal (read-heavy workflows) or might indicate the agent isn't using specialized tools.",
      evidence: sortedTools.slice(0, 5).map(([n, c]) => `${n}: ${c} calls (${((c / totalToolCalls) * 100).toFixed(0)}%)`),
      recommendation: `If "${sortedTools[0][0]}" is "read" or "bash", check if grep/glob could replace some usage. If "edit", verify edits are landing on first try.`,
      affectedSessions: [],
      metric: { label: "Dominant tool", value: `${sortedTools[0][0]} (${((sortedTools[0][1] / totalToolCalls) * 100).toFixed(0)}%)` },
    })
  }

  // ── Successful patterns ──
  const completedSessions = traces.filter((t) => t.summary.status === "completed")
  const successRate = traces.length ? completedSessions.length / traces.length : 0
  if (successRate >= 0.9 && traces.length >= 5) {
    insights.push({
      id: mkId(), severity: "positive", category: "Health",
      title: `${(successRate * 100).toFixed(0)}% success rate across ${traces.length} sessions`,
      description: "The agent is completing tasks reliably. This is a healthy signal.",
      evidence: [`${completedSessions.length} completed, ${traces.length - completedSessions.length} failed/errored`],
      recommendation: "Keep monitoring. Consider increasing task complexity or automating more workflows.",
      affectedSessions: [],
      metric: { label: "Success rate", value: `${(successRate * 100).toFixed(0)}%`, trend: successRate > 0.95 ? "up" : "flat" },
    })
  }

  // ── Cache utilization ──
  const cacheUsers = traces.filter((t) => t.summary.tokens.cacheRead > 0)
  const noCacheUsers = traces.filter((t) => t.summary.tokens.cacheRead === 0 && t.summary.totalTokens > 10000)
  if (noCacheUsers.length > traces.length * 0.5 && traces.length >= 3) {
    insights.push({
      id: mkId(), severity: "info", category: "Efficiency",
      title: `${noCacheUsers.length} of ${traces.length} sessions used zero prompt cache`,
      description: "Prompt caching can significantly reduce costs for repeated context. Many sessions are not benefiting from caching.",
      evidence: [`Sessions with cache: ${cacheUsers.length}`, `Sessions without: ${noCacheUsers.length}`, `Potential savings: ${((noCacheUsers.reduce((s, t) => s + t.summary.tokens.input, 0)) * 0.5 / 1_000_000 * 3).toFixed(2)} USD (estimate)`],
      recommendation: "Enable prompt caching on your provider. Structure system prompts to maximize cache hits.",
      affectedSessions: noCacheUsers.map((t) => t.sessionId),
    })
  }

  // ── Agent distribution ──
  const agentCounts: Record<string, number> = {}
  for (const t of traces) agentCounts[t.metadata.agent ?? "default"] = (agentCounts[t.metadata.agent ?? "default"] ?? 0) + 1
  if (Object.keys(agentCounts).length > 1) {
    const sorted = Object.entries(agentCounts).sort((a, b) => b[1] - a[1])
    insights.push({
      id: mkId(), severity: "info", category: "Usage",
      title: `${Object.keys(agentCounts).length} different agent types in use`,
      description: "Multiple agent types are being used, which is healthy for task specialization.",
      evidence: sorted.map(([a, c]) => `${a}: ${c} sessions (${((c / traces.length) * 100).toFixed(0)}%)`),
      recommendation: "Ensure the right agent type is being used for each task. Builder for implementation, explorer for research, general for mixed tasks.",
      affectedSessions: [],
    })
  }

  return insights.sort((a, b) => {
    const order: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2, positive: 3 }
    return order[a.severity] - order[b.severity]
  })
}

function fmtDur(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}m${s ? s + "s" : ""}`
}
