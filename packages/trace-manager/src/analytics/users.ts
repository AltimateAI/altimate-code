import type { LakeManager } from "../lake/lake-manager"

export interface UserStats {
  userId: string
  sessions: number
  tokens: number
  cost: number
  duration: number
  completed: number
  successRate: number
  topTool: string
  models: Record<string, number>
}

export interface UserAnalytics {
  users: UserStats[]
  heatmap: number[][]
}

export async function getUserAnalytics(lake: LakeManager): Promise<UserAnalytics> {
  const userRows = await lake.query<{
    user_id: string; sessions: number; tokens: number; cost: number
    duration: number; completed: number
  }>(`
    SELECT
      COALESCE(user_id, COALESCE(agent, COALESCE(provider_id, 'unknown'))) as user_id,
      COUNT(*) as sessions,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(total_cost), 0) as cost,
      COALESCE(SUM(duration_ms), 0) as duration,
      COUNT(*) FILTER (WHERE status = 'completed') as completed
    FROM sessions
    GROUP BY user_id
    ORDER BY sessions DESC
  `)

  const users: UserStats[] = []
  for (const row of userRows) {
    const topToolRows = await lake.query<{ name: string; cnt: number }>(`
      SELECT s.name, COUNT(*) as cnt
      FROM spans s
      JOIN sessions sess ON s.session_id = sess.session_id
      WHERE s.kind = 'tool'
        AND COALESCE(sess.user_id, COALESCE(sess.agent, COALESCE(sess.provider_id, 'unknown'))) = '${row.user_id.replace(/'/g, "''")}'
      GROUP BY s.name ORDER BY cnt DESC LIMIT 1
    `)

    const modelRows = await lake.query<{ model: string; cnt: number }>(`
      SELECT COALESCE(model, 'unknown') as model, COUNT(*) as cnt
      FROM sessions
      WHERE COALESCE(user_id, COALESCE(agent, COALESCE(provider_id, 'unknown'))) = '${row.user_id.replace(/'/g, "''")}'
      GROUP BY model
    `)

    const models: Record<string, number> = {}
    for (const m of modelRows) models[m.model] = m.cnt

    users.push({
      userId: row.user_id,
      sessions: row.sessions,
      tokens: row.tokens,
      cost: row.cost,
      duration: row.duration,
      completed: row.completed,
      successRate: row.sessions ? row.completed / row.sessions : 0,
      topTool: topToolRows[0]?.name ?? "-",
      models,
    })
  }

  const heatmapRows = await lake.query<{ dow: number; hour: number; cnt: number }>(`
    SELECT DAYOFWEEK(started_at) as dow, HOUR(started_at) as hour, COUNT(*) as cnt
    FROM sessions WHERE started_at IS NOT NULL
    GROUP BY dow, hour
  `)

  const heatmap: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0))
  for (const row of heatmapRows) {
    const dayIdx = (row.dow) % 7
    heatmap[dayIdx][row.hour] = row.cnt
  }

  return { users, heatmap }
}
