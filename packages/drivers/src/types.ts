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
  /** Skip the default LIMIT injection and post-truncation. Use when the caller
   *  needs the complete, untruncated result set (e.g. data-diff pipelines). */
  noLimit?: boolean
}

/**
 * Pre-execution cost/scan estimate for a query, produced without running it
 * (e.g. BigQuery dry-run, warehouse EXPLAIN). Powers the cost firewall in
 * sql_execute. All fields are optional because estimation accuracy varies by
 * warehouse — a connector returns only what it can determine cheaply.
 */
export interface CostEstimate {
  /** Estimated bytes the query will scan/process. */
  bytesScanned?: number
  /** Free-form note about estimation method or caveats (e.g. "BigQuery dry-run"). */
  note?: string
}

export interface Connector {
  connect(): Promise<void>
  execute(sql: string, limit?: number, binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult>
  listSchemas(): Promise<string[]>
  listTables(schema: string): Promise<Array<{ name: string; type: string }>>
  describeTable(schema: string, table: string): Promise<SchemaColumn[]>
  close(): Promise<void>
  /**
   * Optionally estimate a query's scan cost without executing it. Connectors
   * that cannot estimate cheaply omit this method; callers must treat it as
   * "estimation unsupported" and proceed without a guard.
   */
  estimateCost?(sql: string): Promise<CostEstimate>
}
