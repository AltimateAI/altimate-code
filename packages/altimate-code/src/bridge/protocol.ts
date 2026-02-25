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

export interface DbtModelInfo {
  unique_id: string
  name: string
  schema_name?: string
  database?: string
  materialized?: string
  depends_on: string[]
}

export interface DbtManifestResult {
  models: DbtModelInfo[]
  source_count: number
  model_count: number
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

// --- Method registry ---

export const BridgeMethods = {
  "sql.execute": {} as { params: SqlExecuteParams; result: SqlExecuteResult },
  "sql.validate": {} as { params: SqlValidateParams; result: SqlValidateResult },
  "sql.check": {} as { params: SqlCheckParams; result: SqlCheckResult },
  "sql.analyze": {} as { params: SqlAnalyzeParams; result: SqlAnalyzeResult },
  "sql.optimize": {} as { params: SqlOptimizeParams; result: SqlOptimizeResult },
  "sql.translate": {} as { params: SqlTranslateParams; result: SqlTranslateResult },
  "schema.inspect": {} as { params: SchemaInspectParams; result: SchemaInspectResult },
  "lineage.check": {} as { params: LineageCheckParams; result: LineageCheckResult },
  "dbt.run": {} as { params: DbtRunParams; result: DbtRunResult },
  "dbt.manifest": {} as { params: DbtManifestParams; result: DbtManifestResult },
  "warehouse.list": {} as { params: WarehouseListParams; result: WarehouseListResult },
  "warehouse.test": {} as { params: WarehouseTestParams; result: WarehouseTestResult },
  ping: {} as { params: Record<string, never>; result: { status: string } },
} as const

export type BridgeMethod = keyof typeof BridgeMethods
