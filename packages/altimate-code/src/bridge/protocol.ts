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

export interface SqlAntiPattern {
  type: string
  severity: string
  message: string
  recommendation: string
  location?: string
  confidence: string
}

export interface SqlOptimizeResult {
  success: boolean
  original_sql: string
  optimized_sql?: string
  suggestions: SqlOptimizeSuggestion[]
  anti_patterns: SqlAntiPattern[]
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
  success: boolean
  data: Record<string, unknown>
  error?: string
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

// --- Warehouse Management ---

export interface WarehouseAddParams {
  name: string
  config: Record<string, unknown>
}

export interface WarehouseAddResult {
  success: boolean
  name: string
  type: string
  error?: string
}

export interface WarehouseRemoveParams {
  name: string
}

export interface WarehouseRemoveResult {
  success: boolean
  error?: string
}

// --- Docker Discovery ---

export interface DockerContainer {
  container_id: string
  name: string
  image: string
  db_type: string
  host: string
  port: number
  user?: string
  password?: string
  database?: string
  status: string
}

export interface WarehouseDiscoverResult {
  containers: DockerContainer[]
  container_count: number
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

// --- SQL Explain ---

export interface SqlExplainParams {
  sql: string
  warehouse?: string
  analyze?: boolean
}

export interface SqlExplainResult {
  success: boolean
  plan_text?: string
  plan_rows: Record<string, unknown>[]
  error?: string
  warehouse_type?: string
  analyzed: boolean
}

// --- SQL Format ---

export interface SqlFormatParams {
  sql: string
  dialect?: string
  indent?: number
}

export interface SqlFormatResult {
  success: boolean
  formatted_sql?: string
  statement_count: number
  error?: string
}

// --- SQL Fix ---

export interface SqlFixParams {
  sql: string
  error_message: string
  dialect?: string
}

export interface SqlFixSuggestion {
  type: string
  message: string
  confidence: string
  fixed_sql?: string
}

export interface SqlFixResult {
  success: boolean
  original_sql: string
  fixed_sql?: string
  error_message: string
  suggestions: SqlFixSuggestion[]
  suggestion_count: number
}

// --- SQL Autocomplete ---

export interface SqlAutocompleteParams {
  prefix: string
  position?: string
  warehouse?: string
  table_context?: string[]
  limit?: number
}

export interface SqlAutocompleteSuggestion {
  name: string
  type: string
  detail?: string
  fqn?: string
  table?: string
  warehouse?: string
  in_context: boolean
}

export interface SqlAutocompleteResult {
  suggestions: SqlAutocompleteSuggestion[]
  prefix: string
  position: string
  suggestion_count: number
}

// --- FinOps: Query History ---

export interface QueryHistoryParams {
  warehouse: string
  days?: number
  limit?: number
  user?: string
  warehouse_filter?: string
}

export interface QueryHistoryResult {
  success: boolean
  queries: Record<string, unknown>[]
  summary: Record<string, unknown>
  warehouse_type?: string
  error?: string
}

// --- FinOps: Credit Analysis ---

export interface CreditAnalysisParams {
  warehouse: string
  days?: number
  limit?: number
  warehouse_filter?: string
}

export interface CreditAnalysisResult {
  success: boolean
  daily_usage: Record<string, unknown>[]
  warehouse_summary: Record<string, unknown>[]
  total_credits: number
  days_analyzed: number
  recommendations: Record<string, unknown>[]
  error?: string
}

// --- FinOps: Expensive Queries ---

export interface ExpensiveQueriesParams {
  warehouse: string
  days?: number
  limit?: number
}

export interface ExpensiveQueriesResult {
  success: boolean
  queries: Record<string, unknown>[]
  query_count: number
  days_analyzed: number
  error?: string
}

// --- FinOps: Warehouse Advisor ---

export interface WarehouseAdvisorParams {
  warehouse: string
  days?: number
}

export interface WarehouseAdvisorResult {
  success: boolean
  warehouse_load: Record<string, unknown>[]
  warehouse_performance: Record<string, unknown>[]
  recommendations: Record<string, unknown>[]
  days_analyzed: number
  error?: string
}

// --- FinOps: Unused Resources ---

export interface UnusedResourcesParams {
  warehouse: string
  days?: number
  limit?: number
}

export interface UnusedResourcesResult {
  success: boolean
  unused_tables: Record<string, unknown>[]
  idle_warehouses: Record<string, unknown>[]
  summary: Record<string, unknown>
  days_analyzed: number
  error?: string
}

// --- FinOps: Role & Access ---

export interface RoleGrantsParams {
  warehouse: string
  role?: string
  object_name?: string
  limit?: number
}

export interface RoleGrantsResult {
  success: boolean
  grants: Record<string, unknown>[]
  grant_count: number
  privilege_summary: Record<string, number>
  error?: string
}

export interface RoleHierarchyParams {
  warehouse: string
}

export interface RoleHierarchyResult {
  success: boolean
  hierarchy: Record<string, unknown>[]
  role_count: number
  error?: string
}

export interface UserRolesParams {
  warehouse: string
  user?: string
  limit?: number
}

export interface UserRolesResult {
  success: boolean
  assignments: Record<string, unknown>[]
  assignment_count: number
  error?: string
}

// --- Schema: PII Detection ---

export interface PiiDetectParams {
  warehouse?: string
  schema_name?: string
  table?: string
}

export interface PiiFinding {
  warehouse: string
  schema: string
  table: string
  column: string
  data_type?: string
  pii_category: string
  confidence: string
}

export interface PiiDetectResult {
  success: boolean
  findings: PiiFinding[]
  finding_count: number
  columns_scanned: number
  by_category: Record<string, number>
  tables_with_pii: number
}

// --- Schema: Metadata Tags ---

export interface TagsGetParams {
  warehouse: string
  object_name?: string
  tag_name?: string
  limit?: number
}

export interface TagsGetResult {
  success: boolean
  tags: Record<string, unknown>[]
  tag_count: number
  tag_summary: Record<string, number>
  error?: string
}

export interface TagsListParams {
  warehouse: string
  limit?: number
}

export interface TagsListResult {
  success: boolean
  tags: Record<string, unknown>[]
  tag_count: number
  error?: string
}

// --- SQL Diff ---

export interface SqlDiffParams {
  original: string
  modified: string
  context_lines?: number
}

export interface SqlDiffResult {
  has_changes: boolean
  unified_diff: string
  additions: number
  deletions: number
  change_count: number
  similarity: number
  changes: Record<string, unknown>[]
}

// --- SQL Rewrite ---

export interface SqlRewriteRule {
  rule: string // "SELECT_STAR", "NON_SARGABLE", "LARGE_IN_LIST"
  original_fragment: string
  rewritten_fragment: string
  explanation: string
  can_auto_apply: boolean
}

export interface SqlRewriteParams {
  sql: string
  dialect?: string
  schema_context?: Record<string, any>
}

export interface SqlRewriteResult {
  success: boolean
  original_sql: string
  rewritten_sql?: string
  rewrites_applied: SqlRewriteRule[]
  error?: string
}

// --- Schema Change Detection ---

export interface ColumnChange {
  column: string
  change_type: string // "DROPPED", "ADDED", "TYPE_CHANGED", "RENAMED"
  severity: string // "breaking", "warning", "info"
  message: string
  old_type?: string
  new_type?: string
  new_name?: string
}

export interface SchemaDiffParams {
  old_sql: string
  new_sql: string
  dialect?: string
  schema_context?: Record<string, any>
}

export interface SchemaDiffResult {
  success: boolean
  changes: ColumnChange[]
  has_breaking_changes: boolean
  summary: Record<string, number>
  error?: string
}

// --- sqlguard ---

export interface SqlGuardValidateParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardLintParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardSafetyParams {
  sql: string
}

export interface SqlGuardTranspileParams {
  sql: string
  from_dialect: string
  to_dialect: string
}

export interface SqlGuardExplainParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardCheckParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardResult {
  success: boolean
  data: Record<string, unknown>
  error?: string
}

// --- sqlguard Phase 1 (P0) ---

export interface SqlGuardFixParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
  max_iterations?: number
}

export interface SqlGuardPolicyParams {
  sql: string
  policy_json: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardSemanticsParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardTestgenParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

// --- sqlguard Phase 2 (P1) ---

export interface SqlGuardEquivalenceParams {
  sql1: string
  sql2: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardMigrationParams {
  old_ddl: string
  new_ddl: string
  dialect?: string
}

export interface SqlGuardSchemaDiffParams {
  schema1_path?: string
  schema2_path?: string
  schema1_context?: Record<string, any>
  schema2_context?: Record<string, any>
}

export interface SqlGuardRewriteParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardCorrectParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardGradeParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

// --- sqlguard Phase 3 (P2) ---

export interface SqlGuardClassifyPiiParams {
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardQueryPiiParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardResolveTermParams {
  term: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardColumnLineageParams {
  sql: string
  dialect?: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardTrackLineageParams {
  queries: string[]
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardFormatSqlParams {
  sql: string
  dialect?: string
}

export interface SqlGuardExtractMetadataParams {
  sql: string
  dialect?: string
}

export interface SqlGuardCompareQueriesParams {
  left_sql: string
  right_sql: string
  dialect?: string
}

export interface SqlGuardCompleteToolParams {
  sql: string
  cursor_pos: number
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardOptimizeContextParams {
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardOptimizeForQueryParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardPruneSchemaParams {
  sql: string
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardImportDdlParams {
  ddl: string
  dialect?: string
}

export interface SqlGuardExportDdlParams {
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardFingerprintParams {
  schema_path?: string
  schema_context?: Record<string, any>
}

export interface SqlGuardIntrospectionSqlParams {
  db_type: string
  database: string
  schema_name?: string
}

export interface SqlGuardParseDbtParams {
  project_dir: string
}

export interface SqlGuardIsSafeParams {
  sql: string
}

// --- dbt Lineage ---

export interface DbtLineageParams {
  manifest_path: string
  model: string
  dialect?: string
}

export interface DbtLineageResult {
  model_name: string
  model_unique_id?: string
  compiled_sql?: string
  raw_lineage: Record<string, unknown>
  confidence: string
  confidence_factors: string[]
}

// --- dbt Profile Discovery ---

export interface DbtProfilesParams {
  path?: string
}

export interface DbtProfileConnection {
  name: string
  type: string
  config: Record<string, unknown>
}

export interface DbtProfilesResult {
  success: boolean
  connections: DbtProfileConnection[]
  connection_count: number
  error?: string
}

// --- Local Schema Sync ---

export interface LocalSchemaSyncParams {
  warehouse: string
  target_path?: string
  schemas?: string[]
  sample_rows?: number
  limit?: number
}

export interface LocalSchemaSyncResult {
  success: boolean
  warehouse?: string
  target_path?: string
  tables_synced: number
  columns_synced: number
  schemas_synced: number
  errors?: string[]
  error?: string
}

// --- Local SQL Test ---

export interface LocalTestParams {
  sql: string
  target_path?: string
  target_dialect?: string
}

export interface LocalTestResult {
  success: boolean
  row_count: number
  columns: string[]
  sample_rows: Record<string, unknown>[]
  transpiled: boolean
  transpile_warnings?: string[]
  error?: string
}

// --- Method registry ---

export const BridgeMethods = {
  "sql.execute": {} as { params: SqlExecuteParams; result: SqlExecuteResult },
  "sql.analyze": {} as { params: SqlAnalyzeParams; result: SqlAnalyzeResult },
  "sql.optimize": {} as { params: SqlOptimizeParams; result: SqlOptimizeResult },
  "sql.translate": {} as { params: SqlTranslateParams; result: SqlTranslateResult },
  "sql.explain": {} as { params: SqlExplainParams; result: SqlExplainResult },
  "sql.format": {} as { params: SqlFormatParams; result: SqlFormatResult },
  "sql.fix": {} as { params: SqlFixParams; result: SqlFixResult },
  "sql.autocomplete": {} as { params: SqlAutocompleteParams; result: SqlAutocompleteResult },
  "schema.inspect": {} as { params: SchemaInspectParams; result: SchemaInspectResult },
  "schema.index": {} as { params: SchemaIndexParams; result: SchemaIndexResult },
  "schema.search": {} as { params: SchemaSearchParams; result: SchemaSearchResult },
  "schema.cache_status": {} as { params: SchemaCacheStatusParams; result: SchemaCacheStatusResult },
  "lineage.check": {} as { params: LineageCheckParams; result: LineageCheckResult },
  "dbt.run": {} as { params: DbtRunParams; result: DbtRunResult },
  "dbt.manifest": {} as { params: DbtManifestParams; result: DbtManifestResult },
  "dbt.lineage": {} as { params: DbtLineageParams; result: DbtLineageResult },
  "warehouse.list": {} as { params: WarehouseListParams; result: WarehouseListResult },
  "warehouse.test": {} as { params: WarehouseTestParams; result: WarehouseTestResult },
  "warehouse.add": {} as { params: WarehouseAddParams; result: WarehouseAddResult },
  "warehouse.remove": {} as { params: WarehouseRemoveParams; result: WarehouseRemoveResult },
  "warehouse.discover": {} as { params: Record<string, never>; result: WarehouseDiscoverResult },
  "finops.query_history": {} as { params: QueryHistoryParams; result: QueryHistoryResult },
  "finops.analyze_credits": {} as { params: CreditAnalysisParams; result: CreditAnalysisResult },
  "finops.expensive_queries": {} as { params: ExpensiveQueriesParams; result: ExpensiveQueriesResult },
  "finops.warehouse_advice": {} as { params: WarehouseAdvisorParams; result: WarehouseAdvisorResult },
  "finops.unused_resources": {} as { params: UnusedResourcesParams; result: UnusedResourcesResult },
  "finops.role_grants": {} as { params: RoleGrantsParams; result: RoleGrantsResult },
  "finops.role_hierarchy": {} as { params: RoleHierarchyParams; result: RoleHierarchyResult },
  "finops.user_roles": {} as { params: UserRolesParams; result: UserRolesResult },
  "schema.detect_pii": {} as { params: PiiDetectParams; result: PiiDetectResult },
  "schema.tags": {} as { params: TagsGetParams; result: TagsGetResult },
  "schema.tags_list": {} as { params: TagsListParams; result: TagsListResult },
  "sql.diff": {} as { params: SqlDiffParams; result: SqlDiffResult },
  "sql.rewrite": {} as { params: SqlRewriteParams; result: SqlRewriteResult },
  "sql.schema_diff": {} as { params: SchemaDiffParams; result: SchemaDiffResult },
  // --- dbt discovery ---
  "dbt.profiles": {} as { params: DbtProfilesParams; result: DbtProfilesResult },
  // --- local testing ---
  "local.schema_sync": {} as { params: LocalSchemaSyncParams; result: LocalSchemaSyncResult },
  "local.test": {} as { params: LocalTestParams; result: LocalTestResult },
  // --- sqlguard (existing) ---
  "sqlguard.validate": {} as { params: SqlGuardValidateParams; result: SqlGuardResult },
  "sqlguard.lint": {} as { params: SqlGuardLintParams; result: SqlGuardResult },
  "sqlguard.safety": {} as { params: SqlGuardSafetyParams; result: SqlGuardResult },
  "sqlguard.transpile": {} as { params: SqlGuardTranspileParams; result: SqlGuardResult },
  "sqlguard.explain": {} as { params: SqlGuardExplainParams; result: SqlGuardResult },
  "sqlguard.check": {} as { params: SqlGuardCheckParams; result: SqlGuardResult },
  // --- sqlguard Phase 1 (P0) ---
  "sqlguard.fix": {} as { params: SqlGuardFixParams; result: SqlGuardResult },
  "sqlguard.policy": {} as { params: SqlGuardPolicyParams; result: SqlGuardResult },
  "sqlguard.semantics": {} as { params: SqlGuardSemanticsParams; result: SqlGuardResult },
  "sqlguard.testgen": {} as { params: SqlGuardTestgenParams; result: SqlGuardResult },
  // --- sqlguard Phase 2 (P1) ---
  "sqlguard.equivalence": {} as { params: SqlGuardEquivalenceParams; result: SqlGuardResult },
  "sqlguard.migration": {} as { params: SqlGuardMigrationParams; result: SqlGuardResult },
  "sqlguard.schema_diff": {} as { params: SqlGuardSchemaDiffParams; result: SqlGuardResult },
  "sqlguard.rewrite": {} as { params: SqlGuardRewriteParams; result: SqlGuardResult },
  "sqlguard.correct": {} as { params: SqlGuardCorrectParams; result: SqlGuardResult },
  "sqlguard.grade": {} as { params: SqlGuardGradeParams; result: SqlGuardResult },
  // --- sqlguard Phase 3 (P2) ---
  "sqlguard.classify_pii": {} as { params: SqlGuardClassifyPiiParams; result: SqlGuardResult },
  "sqlguard.query_pii": {} as { params: SqlGuardQueryPiiParams; result: SqlGuardResult },
  "sqlguard.resolve_term": {} as { params: SqlGuardResolveTermParams; result: SqlGuardResult },
  "sqlguard.column_lineage": {} as { params: SqlGuardColumnLineageParams; result: SqlGuardResult },
  "sqlguard.track_lineage": {} as { params: SqlGuardTrackLineageParams; result: SqlGuardResult },
  "sqlguard.format": {} as { params: SqlGuardFormatSqlParams; result: SqlGuardResult },
  "sqlguard.metadata": {} as { params: SqlGuardExtractMetadataParams; result: SqlGuardResult },
  "sqlguard.compare": {} as { params: SqlGuardCompareQueriesParams; result: SqlGuardResult },
  "sqlguard.complete": {} as { params: SqlGuardCompleteToolParams; result: SqlGuardResult },
  "sqlguard.optimize_context": {} as { params: SqlGuardOptimizeContextParams; result: SqlGuardResult },
  "sqlguard.optimize_for_query": {} as { params: SqlGuardOptimizeForQueryParams; result: SqlGuardResult },
  "sqlguard.prune_schema": {} as { params: SqlGuardPruneSchemaParams; result: SqlGuardResult },
  "sqlguard.import_ddl": {} as { params: SqlGuardImportDdlParams; result: SqlGuardResult },
  "sqlguard.export_ddl": {} as { params: SqlGuardExportDdlParams; result: SqlGuardResult },
  "sqlguard.fingerprint": {} as { params: SqlGuardFingerprintParams; result: SqlGuardResult },
  "sqlguard.introspection_sql": {} as { params: SqlGuardIntrospectionSqlParams; result: SqlGuardResult },
  "sqlguard.parse_dbt": {} as { params: SqlGuardParseDbtParams; result: SqlGuardResult },
  "sqlguard.is_safe": {} as { params: SqlGuardIsSafeParams; result: SqlGuardResult },
  ping: {} as { params: Record<string, never>; result: { status: string } },
} as const

export type BridgeMethod = keyof typeof BridgeMethods
