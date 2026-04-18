import { Hono } from "hono"
import { cors } from "hono/cors"
import { loadAllTraces, loadTrace } from "../traces"
import { detectPIIInTrace } from "../pii/detector"
import { redactTrace } from "../pii/redactor"
import { publishTrace } from "../publish/publisher"
import { summarizeTrace, summarizeTraces } from "../summarize/trace-summarizer"
import { loadOrCreateConfig, saveConfig } from "../consent/consent-store"
import { LakeManager } from "../lake/lake-manager"
import { getConversationAnalytics } from "../analytics/conversations"
import { getUserAnalytics } from "../analytics/users"
import type { TraceManagerConfig } from "../types"
import { generateInsights } from "../analytics/insights"
import { detectIssues, classifySessionTopic } from "../analytics/issues"
import { renderDashboardHTML } from "./dashboard-ui"

export async function createApp(options?: { lake?: LakeManager }) {
  const app = new Hono()
  app.use("/*", cors())

  let lake = options?.lake ?? null
  const config = await loadOrCreateConfig()

  async function ensureLake(): Promise<LakeManager> {
    if (!lake) {
      lake = await LakeManager.create(config.lake.path)
    }
    return lake
  }

  // ── Traces ──

  app.get("/api/traces", async (c) => {
    const traces = await loadAllTraces()
    const summaries = traces.map((t) => ({
      sessionId: t.sessionId,
      traceId: t.traceId,
      title: t.metadata.title ?? t.sessionId,
      model: t.metadata.model,
      agent: t.metadata.agent,
      providerId: t.metadata.providerId,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      duration: t.summary.duration,
      status: t.summary.status,
      totalTokens: t.summary.totalTokens,
      totalCost: t.summary.totalCost,
      totalToolCalls: t.summary.totalToolCalls,
      totalGenerations: t.summary.totalGenerations,
      narrative: t.summary.narrative,
      topTools: t.summary.topTools ?? [],
      loops: t.summary.loops ?? [],
      tokens: t.summary.tokens,
    }))
    return c.json({ traces: summaries, total: summaries.length })
  })

  app.get("/api/traces/:id", async (c) => {
    const trace = await loadTrace(c.req.param("id"))
    if (!trace) return c.json({ error: "not found" }, 404)
    return c.json(trace)
  })

  app.get("/api/traces/:id/summary", async (c) => {
    const trace = await loadTrace(c.req.param("id"))
    if (!trace) return c.json({ error: "not found" }, 404)
    return c.json(summarizeTrace(trace))
  })

  // ── PII ──

  app.get("/api/pii/config", async (c) => {
    const cfg = await loadOrCreateConfig()
    return c.json(cfg.consent)
  })

  app.post("/api/pii/config", async (c) => {
    const body = await c.req.json()
    const cfg = await loadOrCreateConfig()
    if (body.piiCategories) cfg.consent.piiCategories = body.piiCategories
    if (body.customPatterns) cfg.consent.customPatterns = body.customPatterns
    await saveConfig(cfg)
    return c.json({ ok: true })
  })

  app.get("/api/pii/preview/:id", async (c) => {
    const trace = await loadTrace(c.req.param("id"))
    if (!trace) return c.json({ error: "not found" }, 404)
    const findings = detectPIIInTrace(trace)
    const cfg = await loadOrCreateConfig()
    return c.json({
      findings: findings.map((f) => ({
        category: f.category,
        field: f.field,
        spanId: f.spanId,
        preview: f.match.slice(0, 3) + "***" + f.match.slice(-2),
        action: cfg.consent.piiCategories[f.category] ?? "redact",
      })),
      total: findings.length,
    })
  })

  // ── Publish ──

  app.post("/api/publish/:id", async (c) => {
    const trace = await loadTrace(c.req.param("id"))
    if (!trace) return c.json({ error: "not found" }, 404)
    const cfg = await loadOrCreateConfig()
    const body = await c.req.json().catch(() => ({}))
    const endpoint = body.endpoint
      ? { name: "custom", url: body.endpoint, headers: body.headers }
      : undefined
    const result = await publishTrace(trace, cfg, endpoint)
    return c.json(result)
  })

  // ── Graph ──

  app.get("/api/graph/spans/:id", async (c) => {
    const trace = await loadTrace(c.req.param("id"))
    if (!trace) return c.json({ error: "not found" }, 404)

    const nodes = trace.spans.map((s) => ({
      id: s.spanId,
      name: s.name,
      kind: s.kind,
      status: s.status,
      duration: s.startTime && s.endTime ? s.endTime - s.startTime : 0,
      tokens: s.tokens?.total ?? (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0),
    }))
    const edges = trace.spans
      .filter((s) => s.parentSpanId)
      .map((s) => ({ source: s.parentSpanId!, target: s.spanId }))

    return c.json({ nodes, edges })
  })

  app.get("/api/graph/dataflow/:id", async (c) => {
    const trace = await loadTrace(c.req.param("id"))
    if (!trace) return c.json({ error: "not found" }, 404)
    const cfg = await loadOrCreateConfig()
    const findings = detectPIIInTrace(trace)

    const nodes: Array<{ id: string; label: string; type: string }> = []
    const edges: Array<{ source: string; target: string; label?: string }> = []

    for (const f of findings) {
      const piiNodeId = `pii-${f.category}-${f.start}`
      nodes.push({ id: piiNodeId, label: `${f.category}: ${f.match.slice(0, 6)}...`, type: "pii" })

      if (f.spanId) {
        const spanNode = nodes.find((n) => n.id === f.spanId)
        if (!spanNode) {
          const span = trace.spans.find((s) => s.spanId === f.spanId)
          nodes.push({ id: f.spanId, label: span?.name ?? f.spanId, type: span?.kind ?? "span" })
        }
        edges.push({
          source: f.field.includes("input") ? piiNodeId : f.spanId,
          target: f.field.includes("input") ? f.spanId : piiNodeId,
          label: f.field,
        })
      }
    }

    return c.json({ nodes, edges })
  })

  app.get("/api/graph/entities/:id", async (c) => {
    const trace = await loadTrace(c.req.param("id"))
    if (!trace) return c.json({ error: "not found" }, 404)

    const entityPatterns: Array<{ type: string; regex: RegExp }> = [
      { type: "file", regex: /(?:[\w.-]+\.(?:ts|js|py|go|rs|tsx|jsx|sql|yaml|json|md))\b/g },
      { type: "function", regex: /(?:function|def|func|fn)\s+(\w+)/g },
      { type: "command", regex: /(?:npm|bun|pip|cargo|go|git|docker|kubectl)\s+\w+/g },
    ]

    const entities = new Map<string, { type: string; spans: Set<string> }>()

    for (const span of trace.spans) {
      const text = [span.input, span.output, span.name].filter(Boolean).join(" ")
      for (const pattern of entityPatterns) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags)
        let m: RegExpExecArray | null
        while ((m = regex.exec(text)) !== null) {
          const entity = m[1] ?? m[0]
          if (entity.length < 3) continue
          const existing = entities.get(entity)
          if (existing) {
            existing.spans.add(span.spanId)
          } else {
            entities.set(entity, { type: pattern.type, spans: new Set([span.spanId]) })
          }
        }
      }
    }

    const nodes = Array.from(entities.entries()).map(([name, data]) => ({
      id: name,
      label: name,
      type: data.type,
      weight: data.spans.size,
    }))

    const edges: Array<{ source: string; target: string; weight: number }> = []
    const entityList = Array.from(entities.entries())
    for (let i = 0; i < entityList.length; i++) {
      for (let j = i + 1; j < entityList.length; j++) {
        const shared = [...entityList[i][1].spans].filter((s) => entityList[j][1].spans.has(s))
        if (shared.length > 0) {
          edges.push({ source: entityList[i][0], target: entityList[j][0], weight: shared.length })
        }
      }
    }

    return c.json({
      nodes: nodes.slice(0, 50),
      edges: edges.sort((a, b) => b.weight - a.weight).slice(0, 100),
    })
  })

  // ── Analytics (DuckDB) ──

  app.get("/api/analytics/overview", async (c) => {
    const traces = await loadAllTraces()
    const totalTokens = traces.reduce((s, t) => s + t.summary.totalTokens, 0)
    const totalCost = traces.reduce((s, t) => s + t.summary.totalCost, 0)
    const totalTools = traces.reduce((s, t) => s + t.summary.totalToolCalls, 0)

    const modelUsage: Record<string, number> = {}
    const costByModel: Record<string, number> = {}
    for (const t of traces) {
      const m = t.metadata.model ?? "unknown"
      modelUsage[m] = (modelUsage[m] ?? 0) + 1
      costByModel[m] = (costByModel[m] ?? 0) + t.summary.totalCost
    }

    return c.json({
      totalSessions: traces.length,
      totalTokens,
      totalCost,
      totalTools,
      modelUsage,
      costByModel,
      recentSessions: traces.slice(0, 5).map((t) => ({
        sessionId: t.sessionId,
        title: t.metadata.title ?? t.sessionId,
        startedAt: t.startedAt,
        duration: t.summary.duration,
        status: t.summary.status,
      })),
    })
  })

  app.get("/api/analytics/conversations", async (c) => {
    const useLake = c.req.query("source") === "lake"
    if (useLake) {
      const l = await ensureLake()
      return c.json(await getConversationAnalytics(l))
    }
    const traces = await loadAllTraces()
    return c.json(buildInMemoryConvoAnalytics(traces))
  })

  app.get("/api/analytics/users", async (c) => {
    const useLake = c.req.query("source") === "lake"
    if (useLake) {
      const l = await ensureLake()
      return c.json(await getUserAnalytics(l))
    }
    const traces = await loadAllTraces()
    return c.json(buildInMemoryUserAnalytics(traces))
  })

  // ── Lake management ──

  app.post("/api/lake/ingest", async (c) => {
    const traces = await loadAllTraces()
    const l = await ensureLake()
    let ingested = 0
    for (const t of traces) {
      await l.ingest(t)
      ingested++
    }
    return c.json({ ingested, total: traces.length })
  })

  app.get("/api/lake/status", async (c) => {
    try {
      const l = await ensureLake()
      const count = await l.getSessionCount()
      return c.json({ connected: true, sessions: count, path: config.lake.path })
    } catch (e) {
      return c.json({ connected: false, error: String(e) })
    }
  })

  // ── Consent ──

  app.get("/api/consent", async (c) => {
    const cfg = await loadOrCreateConfig()
    return c.json(cfg)
  })

  app.post("/api/consent", async (c) => {
    const body = await c.req.json()
    const cfg = await loadOrCreateConfig()
    if (body.piiCategories) cfg.consent.piiCategories = body.piiCategories
    if (body.autoPublish !== undefined) cfg.consent.autoPublish = body.autoPublish
    if (body.autoIngest !== undefined) cfg.consent.autoIngest = body.autoIngest
    cfg.consent.acceptedAt = new Date().toISOString()
    await saveConfig(cfg)
    return c.json({ ok: true })
  })

  // ── Insights ──

  app.get("/api/insights", async (c) => {
    const traces = await loadAllTraces()
    return c.json(generateInsights(traces))
  })

  // ── Issues ──

  app.get("/api/issues", async (c) => {
    const traces = await loadAllTraces()
    const issues = detectIssues(traces)
    return c.json({ issues, total: issues.length })
  })

  // ── Topic classification ──

  app.get("/api/traces/:id/topics", async (c) => {
    const trace = await loadTrace(c.req.param("id"))
    if (!trace) return c.json({ error: "not found" }, 404)
    return c.json({ topics: classifySessionTopic(trace) })
  })

  app.get("/api/topics", async (c) => {
    const traces = await loadAllTraces()
    const topicCounts: Record<string, number> = {}
    for (const t of traces) {
      for (const topic of classifySessionTopic(t)) {
        topicCounts[topic] = (topicCounts[topic] ?? 0) + 1
      }
    }
    return c.json(Object.entries(topicCounts).map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count))
  })

  // ── Trace detail (full spans for detail view) ──

  app.get("/api/traces/:id/detail", async (c) => {
    const trace = await loadTrace(c.req.param("id"))
    if (!trace) return c.json({ error: "not found" }, 404)
    const findings = detectPIIInTrace(trace)
    const topics = classifySessionTopic(trace)
    const summary = summarizeTrace(trace)

    const spans = trace.spans.map((s) => ({
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      name: s.name,
      kind: s.kind,
      status: s.status,
      startTime: s.startTime,
      endTime: s.endTime,
      duration: s.startTime && s.endTime ? s.endTime - s.startTime : null,
      model: typeof s.model === "string" ? s.model : s.model?.modelId,
      tokens: s.tokens,
      cost: s.cost,
      inputPreview: s.input ? (typeof s.input === "string" ? s.input : JSON.stringify(s.input)).slice(0, 300) : null,
      outputPreview: s.output ? (typeof s.output === "string" ? s.output : JSON.stringify(s.output)).slice(0, 300) : null,
      hasInput: !!s.input,
      hasOutput: !!s.output,
    }))

    return c.json({
      sessionId: trace.sessionId,
      traceId: trace.traceId,
      metadata: trace.metadata,
      summary: trace.summary,
      topics,
      piiCount: findings.length,
      piiFindingsPreview: findings.slice(0, 10).map((f) => ({
        category: f.category,
        field: f.field,
        spanId: f.spanId,
      })),
      spans,
      report: summary,
    })
  })

  // ── Dashboard UI ──

  app.get("/", (c) => c.html(renderDashboardHTML()))

  return app
}

function buildInMemoryConvoAnalytics(traces: import("../types").TraceFile[]) {
  const completed = traces.filter((t) => t.summary.status === "completed")
  const errored = traces.filter((t) => t.summary.status === "error" || t.summary.status === "crashed")
  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
  const p = (arr: number[], pct: number) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * pct)] ?? 0 }

  const durations = traces.map((t) => t.summary.duration)
  const toolFreq: Record<string, number> = {}
  const toolDur: Record<string, number> = {}
  for (const t of traces) for (const tt of t.summary.topTools ?? []) {
    toolFreq[tt.name] = (toolFreq[tt.name] ?? 0) + tt.count
    toolDur[tt.name] = (toolDur[tt.name] ?? 0) + tt.totalDuration
  }
  const topTools = Object.entries(toolFreq).map(([name, count]) => ({ name, count, totalDuration: toolDur[name] ?? 0 })).sort((a, b) => b.count - a.count).slice(0, 10)

  const chains: Record<string, number> = {}
  for (const t of traces) {
    const ts = t.spans.filter((s) => s.kind === "tool").sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))
    for (let i = 0; i < ts.length - 1; i++) chains[`${ts[i].name}→${ts[i + 1].name}`] = (chains[`${ts[i].name}→${ts[i + 1].name}`] ?? 0) + 1
  }
  const topChains = Object.entries(chains).map(([pattern, count]) => ({ pattern, count })).sort((a, b) => b.count - a.count).slice(0, 8)

  const turnBuckets: Record<string, number> = { "1-3": 0, "4-8": 0, "9-15": 0, "16+": 0 }
  for (const t of traces) { const g = t.summary.totalGenerations; if (g <= 3) turnBuckets["1-3"]++; else if (g <= 8) turnBuckets["4-8"]++; else if (g <= 15) turnBuckets["9-15"]++; else turnBuckets["16+"]++ }

  const genDurs = traces.flatMap((t) => t.spans.filter((s) => s.kind === "generation" && s.startTime && s.endTime).map((s) => s.endTime! - s.startTime!))

  return {
    totalSessions: traces.length, completedSessions: completed.length, erroredSessions: errored.length,
    successRate: traces.length ? completed.length / traces.length : 0,
    avgDuration: avg(durations), avgToolCalls: avg(traces.map((t) => t.summary.totalToolCalls)),
    avgGenerations: avg(traces.map((t) => t.summary.totalGenerations)), avgTokens: avg(traces.map((t) => t.summary.totalTokens)),
    p50Duration: p(durations, 0.5), p90Duration: p(durations, 0.9),
    p50Latency: p(genDurs, 0.5), p90Latency: p(genDurs, 0.9), p99Latency: p(genDurs, 0.99),
    topTools, topChains, turnDistribution: turnBuckets,
    doomLoops: traces.filter((t) => t.summary.loops?.length).length,
    toolErrors: traces.reduce((n, t) => n + t.spans.filter((s) => s.kind === "tool" && s.status === "error").length, 0),
  }
}

function buildInMemoryUserAnalytics(traces: import("../types").TraceFile[]) {
  const userMap: Record<string, { sessions: number; tokens: number; cost: number; duration: number; completed: number; toolUsage: Record<string, number>; hourBuckets: number[]; dayBuckets: number[] }> = {}
  for (const t of traces) {
    const uid = t.metadata.userId ?? t.metadata.agent ?? t.metadata.providerId ?? "unknown"
    if (!userMap[uid]) userMap[uid] = { sessions: 0, tokens: 0, cost: 0, duration: 0, completed: 0, toolUsage: {}, hourBuckets: new Array(24).fill(0), dayBuckets: new Array(7).fill(0) }
    const u = userMap[uid]; u.sessions++; u.tokens += t.summary.totalTokens; u.cost += t.summary.totalCost; u.duration += t.summary.duration
    if (t.summary.status === "completed") u.completed++
    const d = new Date(t.startedAt); u.hourBuckets[d.getHours()]++; u.dayBuckets[d.getDay()]++
    for (const tt of t.summary.topTools ?? []) u.toolUsage[tt.name] = (u.toolUsage[tt.name] ?? 0) + tt.count
  }
  const users = Object.entries(userMap).map(([userId, data]) => ({
    userId, ...data, successRate: data.sessions ? data.completed / data.sessions : 0,
    topTool: Object.entries(data.toolUsage).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-",
  })).sort((a, b) => b.sessions - a.sessions)

  const heatmap: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0))
  for (const t of traces) { const d = new Date(t.startedAt); heatmap[d.getDay()][d.getHours()]++ }
  return { users, heatmap }
}
