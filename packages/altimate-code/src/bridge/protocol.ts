/**
 * Bridge protocol — RPC method contracts between TypeScript CLI and Python engine.
 * Define types here FIRST, then implement both sides against these contracts.
 */

// --- SQL ---

export interface SqlExecuteParams {
  sql: string
  warehouse?: string
  limit?: number
}

export interface SqlExecuteResult {
  columns: string[]
  rows: any[][]
  row_count: number
  truncated: boolean
}

export interface SqlValidateParams {
  sql: string
  dialect?: string
}

export interface SqlValidateResult {
  valid: boolean
  errors: string[]
  normalized?: string
}

export interface SqlCheckParams {
  sql: string
  mode?: "full" | "read-only"
  dialect?: string
}

export interface SqlCheckIssue {
  code: string
  message: string
  severity: string
  line?: number
  column?: number
}

export interface SqlCheckResult {
  safe: boolean
  issues: SqlCheckIssue[]
}

// --- SQL Analyze ---

export interface SqlAnalyzeParams {
  sql: string
  dialect?: string
  schema_context?: Record<string, any>
}

export interface SqlAnalyzeIssue {
  type: string
  severity: string
  message: string
  recommendation: string
  location?: string
  confidence: string
}

export interface SqlAnalyzeResult {
  success: boolean
  issues: SqlAnalyzeIssue[]
  issue_count: number
  confidence: string
  confidence_factors: string[]
  error?: string
}

// --- SQL Translate ---

export interface SqlTranslateParams {
  sql: string
  source_dialect: string
  target_dialect: string
}

export interface SqlTranslateResult {
  success: boolean
  translated_sql?: string
  source_dialect: string
  target_dialect: string
  warnings: string[]
  error?: string
}

// --- SQL Optimize ---

export interface SqlOptimizeSuggestion {
  type: string // REWRITE, INDEX_HINT, STRUCTURE, PERFORMANCE
  description: string
  before?: string
  after?: string
  impact: string // high, medium, low
}

export interface SqlOptimizeParams {
  sql: string
  dialect?: string
  schema_context?: Record<string, any>
}

export interface SqlOptimizeResult {
  success: boolean
  original_sql: string
  optimized_sql?: string
  suggestions: SqlOptimizeSuggestion[]
  anti_patterns: Record<string, any>[]
  confidence: string
  error?: string
}

// --- Schema ---

export interface SchemaInspectParams {
  table: string
  schema_name?: string
  warehouse?: string
}

export interface SchemaColumn {
  name: string
  data_type: string
  nullable: boolean
  primary_key: boolean
  description?: string
}

export interface SchemaInspectResult {
  table: string
  schema_name?: string
  columns: SchemaColumn[]
  row_count?: number
}

// --- Lineage ---

export interface LineageCheckParams {
  sql: string
  dialect?: string
  schema_context?: Record<string, { name: string; data_type: string }[]>
}

export interface LineageEdge {
  source_table: string
  source_column: string
  target_table: string
  target_column: string
  transform?: string
}

export interface LineageCheckResult {
  edges: LineageEdge[]
  tables: string[]
  columns: string[]
  confidence: string
  confidence_factors: string[]
}

// --- dbt ---

export interface DbtRunParams {
  command?: string
  select?: string
  args?: string[]
  project_dir?: string
}

export interface DbtRunResult {
  stdout: string
  stderr: string
  exit_code: number
}

export interface DbtManifestParams {
  path: string
}

export interface ModelColumn {
  name: string
  data_type: string
  description?: string
}

export interface DbtModelInfo {
  unique_id: string
  name: string
  schema_name?: string
  database?: string
  materialized?: string
  depends_on: string[]
  columns: ModelColumn[]
}

export interface DbtSourceInfo {
  unique_id: string
  name: string
  source_name: string
  schema_name?: string
  database?: string
  columns: ModelColumn[]
}

export interface DbtManifestResult {
  models: DbtModelInfo[]
  sources: DbtSourceInfo[]
  source_count: number
  model_count: number
  test_count: number
  snapshot_count: number
  seed_count: number
}

// --- Warehouse ---

export interface WarehouseListParams {}

export interface WarehouseInfo {
  name: string
  type: string
  database?: string
}

export interface WarehouseListResult {
  warehouses: WarehouseInfo[]
}

export interface WarehouseTestParams {
  name: string
}

export interface WarehouseTestResult {
  connected: boolean
  error?: string
}

// --- Schema Cache (Indexing & Search) ---

export interface SchemaIndexParams {
  warehouse: string
}

export interface SchemaIndexResult {
  warehouse: string
  type: string
  schemas_indexed: number
  tables_indexed: number
  columns_indexed: number
  timestamp: string
}

export interface SchemaSearchParams {
  query: string
  warehouse?: string
  limit?: number
}

export interface SchemaSearchTableResult {
  warehouse: string
  database?: string
  schema_name: string
  name: string
  type: string
  row_count?: number
  fqn: string
}

export interface SchemaSearchColumnResult {
  warehouse: string
  database?: string
  schema_name: string
  table: string
  name: string
  data_type?: string
  nullable: boolean
  fqn: string
}

export interface SchemaSearchResult {
  tables: SchemaSearchTableResult[]
  columns: SchemaSearchColumnResult[]
  query: string
  match_count: number
}

export interface SchemaCacheStatusParams {}

export interface SchemaCacheWarehouseStatus {
  name: string
  type: string
  last_indexed?: string
  databases_count: number
  schemas_count: number
  tables_count: number
  columns_count: number
}

export interface SchemaCacheStatusResult {
  warehouses: SchemaCacheWarehouseStatus[]
  total_tables: number
  total_columns: number
  cache_path: string
}

// --- SQL Feedback & Cost Prediction ---

export interface SqlRecordFeedbackParams {
  sql: string
  dialect?: string
  bytes_scanned?: number
  rows_produced?: number
  execution_time_ms?: number
  credits_used?: number
  warehouse_size?: string
}

export interface SqlRecordFeedbackResult {
  recorded: boolean
}

export interface SqlPredictCostParams {
  sql: string
  dialect?: string
}

export interface SqlPredictCostResult {
  tier: number
  confidence: string
  predicted_bytes?: number
  predicted_time_ms?: number
  predicted_credits?: number
  method: string
  observation_count: number
}

// --- Method registry ---

export const BridgeMethods = {
  "sql.execute": {} as { params: SqlExecuteParams; result: SqlExecuteResult },
  "sql.validate": {} as { params: SqlValidateParams; result: SqlValidateResult },
  "sql.check": {} as { params: SqlCheckParams; result: SqlCheckResult },
  "sql.analyze": {} as { params: SqlAnalyzeParams; result: SqlAnalyzeResult },
  "sql.optimize": {} as { params: SqlOptimizeParams; result: SqlOptimizeResult },
  "sql.translate": {} as { params: SqlTranslateParams; result: SqlTranslateResult },
  "sql.record_feedback": {} as { params: SqlRecordFeedbackParams; result: SqlRecordFeedbackResult },
  "sql.predict_cost": {} as { params: SqlPredictCostParams; result: SqlPredictCostResult },
  "schema.inspect": {} as { params: SchemaInspectParams; result: SchemaInspectResult },
  "schema.index": {} as { params: SchemaIndexParams; result: SchemaIndexResult },
  "schema.search": {} as { params: SchemaSearchParams; result: SchemaSearchResult },
  "schema.cache_status": {} as { params: SchemaCacheStatusParams; result: SchemaCacheStatusResult },
  "lineage.check": {} as { params: LineageCheckParams; result: LineageCheckResult },
  "dbt.run": {} as { params: DbtRunParams; result: DbtRunResult },
  "dbt.manifest": {} as { params: DbtManifestParams; result: DbtManifestResult },
  "warehouse.list": {} as { params: WarehouseListParams; result: WarehouseListResult },
  "warehouse.test": {} as { params: WarehouseTestParams; result: WarehouseTestResult },
  ping: {} as { params: Record<string, never>; result: { status: string } },
} as const

export type BridgeMethod = keyof typeof BridgeMethods
