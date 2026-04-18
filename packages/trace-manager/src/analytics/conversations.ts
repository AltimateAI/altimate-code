import type { LakeManager } from "../lake/lake-manager"

export interface ConversationAnalytics {
  totalSessions: number
  completedSessions: number
  erroredSessions: number
  successRate: number
  avgDuration: number
  avgToolCalls: number
  avgGenerations: number
  avgTokens: number
  p50Duration: number
  p90Duration: number
  p50Latency: number
  p90Latency: number
  p99Latency: number
  topTools: Array<{ name: string; count: number; totalDuration: number }>
  topChains: Array<{ pattern: string; count: number }>
  turnDistribution: Record<string, number>
  doomLoops: number
  toolErrors: number
}

export async function getConversationAnalytics(lake: LakeManager): Promise<ConversationAnalytics> {
  const [totals] = await lake.query<{
    total: number; completed: number; errored: number
    avg_dur: number; avg_tools: number; avg_gens: number; avg_tokens: number
    p50_dur: number; p90_dur: number
  }>(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE status IN ('error', 'crashed')) as errored,
      AVG(duration_ms) as avg_dur,
      AVG(total_tool_calls) as avg_tools,
      AVG(total_generations) as avg_gens,
      AVG(total_tokens) as avg_tokens,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) as p50_dur,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY duration_ms) as p90_dur
    FROM sessions
  `)

  const latency = await lake.query<{ p50: number; p90: number; p99: number }>(`
    SELECT
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms), 0) as p50,
      COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY duration_ms), 0) as p90,
      COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms), 0) as p99
    FROM spans WHERE kind = 'generation' AND duration_ms IS NOT NULL AND duration_ms > 0
  `)

  const toolRows = await lake.query<{ name: string; cnt: number; dur: number }>(`
    SELECT name, COUNT(*) as cnt, COALESCE(SUM(duration_ms), 0) as dur
    FROM spans WHERE kind = 'tool'
    GROUP BY name ORDER BY cnt DESC LIMIT 10
  `)

  const chainRows = await lake.query<{ chain: string; cnt: number }>(`
    WITH ordered AS (
      SELECT session_id, name, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY started_at) as rn
      FROM spans WHERE kind = 'tool' AND started_at IS NOT NULL
    )
    SELECT a.name || '→' || b.name as chain, COUNT(*) as cnt
    FROM ordered a JOIN ordered b ON a.session_id = b.session_id AND b.rn = a.rn + 1
    GROUP BY chain ORDER BY cnt DESC LIMIT 8
  `)

  const turnBuckets = await lake.query<{ bucket: string; cnt: number }>(`
    SELECT
      CASE
        WHEN total_generations <= 3 THEN '1-3'
        WHEN total_generations <= 8 THEN '4-8'
        WHEN total_generations <= 15 THEN '9-15'
        ELSE '16+'
      END as bucket,
      COUNT(*) as cnt
    FROM sessions GROUP BY bucket
  `)

  const [loopCount] = await lake.query<{ n: number }>(
    "SELECT COUNT(*) as n FROM sessions WHERE loops != '[]' AND loops IS NOT NULL"
  )
  const [errCount] = await lake.query<{ n: number }>(
    "SELECT COUNT(*) as n FROM spans WHERE kind = 'tool' AND status = 'error'"
  )

  const dist: Record<string, number> = { "1-3": 0, "4-8": 0, "9-15": 0, "16+": 0 }
  for (const row of turnBuckets) dist[row.bucket] = row.cnt

  return {
    totalSessions: totals?.total ?? 0,
    completedSessions: totals?.completed ?? 0,
    erroredSessions: totals?.errored ?? 0,
    successRate: totals?.total ? (totals.completed ?? 0) / totals.total : 0,
    avgDuration: totals?.avg_dur ?? 0,
    avgToolCalls: totals?.avg_tools ?? 0,
    avgGenerations: totals?.avg_gens ?? 0,
    avgTokens: totals?.avg_tokens ?? 0,
    p50Duration: totals?.p50_dur ?? 0,
    p90Duration: totals?.p90_dur ?? 0,
    p50Latency: latency[0]?.p50 ?? 0,
    p90Latency: latency[0]?.p90 ?? 0,
    p99Latency: latency[0]?.p99 ?? 0,
    topTools: toolRows.map((r) => ({ name: r.name, count: r.cnt, totalDuration: r.dur })),
    topChains: chainRows.map((r) => ({ pattern: r.chain, count: r.cnt })),
    turnDistribution: dist,
    doomLoops: loopCount?.n ?? 0,
    toolErrors: errCount?.n ?? 0,
  }
}
