import type { TraceFile, PIIFinding } from "../types"

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR PRIMARY KEY,
  trace_id VARCHAR,
  title VARCHAR,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  duration_ms INTEGER,
  status VARCHAR,
  model VARCHAR,
  provider_id VARCHAR,
  agent VARCHAR,
  user_id VARCHAR,
  total_tokens INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  total_cost DOUBLE,
  total_tool_calls INTEGER,
  total_generations INTEGER,
  narrative TEXT,
  top_tools JSON,
  loops JSON,
  ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS spans (
  span_id VARCHAR,
  session_id VARCHAR,
  parent_span_id VARCHAR,
  name VARCHAR,
  kind VARCHAR,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  duration_ms INTEGER,
  status VARCHAR,
  model VARCHAR,
  tokens_input INTEGER,
  tokens_output INTEGER,
  cost DOUBLE,
  tool_call_id VARCHAR,
  input_preview VARCHAR,
  output_preview VARCHAR,
  PRIMARY KEY (span_id, session_id)
);

CREATE TABLE IF NOT EXISTS pii_findings (
  id INTEGER PRIMARY KEY,
  session_id VARCHAR,
  span_id VARCHAR,
  field_path VARCHAR,
  category VARCHAR,
  action_taken VARCHAR,
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`

type DuckDB = any

export class LakeManager {
  private db: DuckDB
  private conn: any

  private constructor(db: DuckDB, conn: any) {
    this.db = db
    this.conn = conn
  }

  static async create(dbPath: string): Promise<LakeManager> {
    const duckdb = await import("duckdb")
    return new Promise((resolve, reject) => {
      const db = new (duckdb.default ?? duckdb).Database(dbPath, {}, (err: Error | null) => {
        if (err) return reject(err)
        const conn = db.connect()
        const lake = new LakeManager(db, conn)
        lake.initSchema().then(() => resolve(lake)).catch(reject)
      })
    })
  }

  private async initSchema(): Promise<void> {
    const stmts = SCHEMA_DDL.split(";").filter((s) => s.trim())
    for (const stmt of stmts) {
      await this.exec(stmt)
    }
  }

  private exec(sql: string, params?: any[]): Promise<void> {
    return new Promise((resolve, reject) => {
      if (params?.length) {
        this.conn.run(sql, ...params, (err: Error | null) => (err ? reject(err) : resolve()))
      } else {
        this.conn.exec(sql, (err: Error | null) => (err ? reject(err) : resolve()))
      }
    })
  }

  async query<T = Record<string, unknown>>(sql: string, params?: any[]): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null, rows: T[]) => (err ? reject(err) : resolve(rows ?? []))
      if (params?.length) {
        this.conn.all(sql, ...params, cb)
      } else {
        this.conn.all(sql, cb)
      }
    })
  }

  async ingest(trace: TraceFile): Promise<void> {
    const toTs = (iso?: string) => (iso ? `'${iso}'` : "NULL")
    const esc = (s?: string | null) => (s ? `'${s.replace(/'/g, "''")}'` : "NULL")
    const preview = (s?: string | null, maxLen = 500) => {
      if (!s) return "NULL"
      const trimmed = s.length > maxLen ? s.slice(0, maxLen) : s
      return esc(trimmed)
    }

    await this.exec(`DELETE FROM spans WHERE session_id = ${esc(trace.sessionId)}`)
    await this.exec(`DELETE FROM sessions WHERE session_id = ${esc(trace.sessionId)}`)

    await this.exec(`INSERT INTO sessions VALUES (
      ${esc(trace.sessionId)}, ${esc(trace.traceId)}, ${esc(trace.metadata.title)},
      ${toTs(trace.startedAt)}, ${toTs(trace.endedAt)}, ${trace.summary.duration},
      ${esc(trace.summary.status)}, ${esc(trace.metadata.model)}, ${esc(trace.metadata.providerId)},
      ${esc(trace.metadata.agent)}, ${esc(trace.metadata.userId)},
      ${trace.summary.totalTokens}, ${trace.summary.tokens.input}, ${trace.summary.tokens.output},
      ${trace.summary.tokens.cacheRead}, ${trace.summary.totalCost},
      ${trace.summary.totalToolCalls}, ${trace.summary.totalGenerations},
      ${esc(trace.summary.narrative)},
      ${esc(JSON.stringify(trace.summary.topTools ?? []))},
      ${esc(JSON.stringify(trace.summary.loops ?? []))},
      CURRENT_TIMESTAMP
    )`)

    for (const span of trace.spans) {
      const startTs = span.startTime ? `EPOCH_MS(${span.startTime})` : "NULL"
      const endTs = span.endTime ? `EPOCH_MS(${span.endTime})` : "NULL"
      const dur = span.startTime && span.endTime ? span.endTime - span.startTime : "NULL"
      const model =
        typeof span.model === "string"
          ? span.model
          : span.model?.modelId ?? null

      await this.exec(`INSERT OR REPLACE INTO spans VALUES (
        ${esc(span.spanId)}, ${esc(trace.sessionId)}, ${esc(span.parentSpanId)},
        ${esc(span.name)}, ${esc(span.kind)},
        ${startTs}, ${endTs}, ${dur},
        ${esc(span.status)}, ${esc(model)},
        ${span.tokens?.input ?? "NULL"}, ${span.tokens?.output ?? "NULL"},
        ${span.cost ?? "NULL"}, ${esc(span.tool?.callId)},
        ${preview(span.input)}, ${preview(span.output)}
      )`)
    }
  }

  async recordPIIFindings(sessionId: string, findings: PIIFinding[], action: string): Promise<void> {
    for (const f of findings) {
      await this.exec(`INSERT INTO pii_findings (session_id, span_id, field_path, category, action_taken)
        VALUES ('${sessionId}', ${f.spanId ? `'${f.spanId}'` : "NULL"}, '${f.field}', '${f.category}', '${action}')`)
    }
  }

  async getSessionCount(): Promise<number> {
    const rows = await this.query<{ n: number }>("SELECT COUNT(*) as n FROM sessions")
    return rows[0]?.n ?? 0
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.db.close(() => resolve())
    })
  }
}
