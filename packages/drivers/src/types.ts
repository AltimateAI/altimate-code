/**
 * Shared types for the native connection manager.
 */

export interface ConnectionConfig {
  type: string
  [key: string]: unknown
}

export interface ConnectorResult {
  columns: string[]
  rows: any[][]
  row_count: number
  truncated: boolean
}

export interface SchemaColumn {
  name: string
  data_type: string
  nullable: boolean
}

export interface ExecuteOptions {
  // altimate_change start — bounded extraction is enforced while consuming source rows
  /** Serialized row byte ceiling. Requires Connector.supportsResultByteLimit. */
  maxResultBytes?: number
  // altimate_change end
  // altimate_change start — PostgreSQL source extraction uses a pinned, rolled-back transaction
  /** PostgreSQL only: execute in a READ ONLY transaction and roll it back before releasing the client. */
  readOnly?: boolean
  // altimate_change end
  /** Skip the default LIMIT injection and post-truncation. Use when the caller
   *  needs the complete, untruncated result set (e.g. data-diff pipelines). */
  noLimit?: boolean
  /** Execution deadline for this call, in milliseconds. `0` disables the
   *  deadline. When omitted the driver resolves one from the connection's
   *  `query_timeout_ms`, then `ALTIMATE_SQL_QUERY_TIMEOUT_MS`, then the
   *  120 s default (see `query-timeout.ts`). */
  queryTimeoutMs?: number
}

/** Stable machine-readable code carried by every query deadline failure. */
export const QUERY_TIMEOUT_CODE = "QUERY_TIMEOUT"

/**
 * A query ran past its execution deadline.
 *
 * Carries a stable `code` so callers can tell a deadline from any other
 * failure without parsing text, and says whether the engine actually stopped
 * the work (`cancelled`) — a client-side deadline cannot always guarantee it.
 */
export class QueryTimeoutError extends Error {
  readonly code = QUERY_TIMEOUT_CODE
  readonly timeoutMs: number
  readonly engine: string
  readonly cancelled: boolean
  /** Session state discarded to stop the query (temp tables, `:memory:` data). */
  readonly stateLost: boolean

  constructor(opts: {
    engine: string
    timeoutMs: number
    cancelled?: boolean
    stateLost?: boolean
    detail?: string
  }) {
    const cancelled = opts.cancelled ?? true
    super(
      `${QUERY_TIMEOUT_CODE}: ${opts.engine} query exceeded the ${formatDeadline(opts.timeoutMs)} execution deadline ` +
        (cancelled ? "and was cancelled. " : "and was abandoned; it may still be running on the server. ") +
        (opts.detail ? `${opts.detail} ` : "") +
        "Narrow the query (filters, a smaller sample, pre-aggregation) or set query_timeout_ms on the connection " +
        "(0 disables the deadline) / ALTIMATE_SQL_QUERY_TIMEOUT_MS to allow longer runs.",
    )
    this.name = "QueryTimeoutError"
    this.timeoutMs = opts.timeoutMs
    this.engine = opts.engine
    this.cancelled = cancelled
    this.stateLost = opts.stateLost ?? false
  }
}

function formatDeadline(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}

/** Duck-typed so it survives module duplication and wrapped error shapes. */
export function isQueryTimeoutError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === QUERY_TIMEOUT_CODE
}

export interface Connector {
  // altimate_change start — callers must fail closed when byte-bounded transfer is unavailable
  readonly supportsResultByteLimit?: boolean
  // altimate_change end
  connect(): Promise<void>
  execute(sql: string, limit?: number, binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult>
  listSchemas(): Promise<string[]>
  listTables(schema: string): Promise<Array<{ name: string; type: string }>>
  describeTable(schema: string, table: string): Promise<SchemaColumn[]>
  close(): Promise<void>
}
