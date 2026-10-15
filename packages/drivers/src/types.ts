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

export interface Connector {
  connect(): Promise<void>
  execute(sql: string, limit?: number, binds?: any[], options?: ExecuteOptions): Promise<ConnectorResult>
  listSchemas(): Promise<string[]>
  listTables(schema: string): Promise<Array<{ name: string; type: string }>>
  describeTable(schema: string, table: string): Promise<SchemaColumn[]>
  close(): Promise<void>
}
