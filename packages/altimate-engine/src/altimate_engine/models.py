"""Pydantic models for JSON-RPC request/response types."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# --- Common ---


class ModelColumn(BaseModel):
    name: str
    data_type: str
    description: str | None = None


# --- SQL ---


class SqlExecuteParams(BaseModel):
    sql: str
    warehouse: str | None = None
    limit: int = 500


class SqlExecuteResult(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    row_count: int
    truncated: bool = False


class SqlTranslateParams(BaseModel):
    sql: str
    source_dialect: str
    target_dialect: str


class SqlTranslateResult(BaseModel):
    success: bool
    translated_sql: str | None = None
    source_dialect: str
    target_dialect: str
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None


# --- SQL Analyze ---


class SqlAnalyzeParams(BaseModel):
    sql: str
    dialect: str | None = None
    schema_context: dict[str, Any] | None = None


class SqlAnalyzeIssue(BaseModel):
    type: str
    severity: str = "warning"
    message: str
    recommendation: str
    location: str | None = None
    confidence: str = "high"


class SqlAnalyzeResult(BaseModel):
    success: bool
    issues: list[SqlAnalyzeIssue] = Field(default_factory=list)
    issue_count: int = 0
    confidence: str = "high"
    confidence_factors: list[str] = Field(default_factory=list)
    error: str | None = None


# --- SQL Optimize ---


class SqlOptimizeSuggestion(BaseModel):
    type: str  # REWRITE, INDEX_HINT, STRUCTURE, PERFORMANCE
    description: str
    before: str | None = None
    after: str | None = None
    impact: str = "medium"  # high, medium, low


class SqlOptimizeParams(BaseModel):
    sql: str
    dialect: str = "snowflake"
    schema_context: dict[str, Any] | None = None


class SqlOptimizeResult(BaseModel):
    success: bool
    original_sql: str
    optimized_sql: str | None = None
    suggestions: list[SqlOptimizeSuggestion] = Field(default_factory=list)
    anti_patterns: list[dict] = Field(default_factory=list)
    confidence: str = "high"
    error: str | None = None


# --- SQL Explain ---


class SqlExplainParams(BaseModel):
    sql: str
    warehouse: str | None = None
    analyze: bool = False


class SqlExplainResult(BaseModel):
    success: bool
    plan_text: str | None = None
    plan_rows: list[dict[str, Any]] = Field(default_factory=list)
    error: str | None = None
    warehouse_type: str | None = None
    analyzed: bool = False


# --- SQL Format ---


class SqlFormatParams(BaseModel):
    sql: str
    dialect: str = "snowflake"
    indent: int = 2


class SqlFormatResult(BaseModel):
    success: bool
    formatted_sql: str | None = None
    statement_count: int = 0
    error: str | None = None


# --- SQL Fix ---


class SqlFixParams(BaseModel):
    sql: str
    error_message: str
    dialect: str = "snowflake"


class SqlFixSuggestion(BaseModel):
    type: str
    message: str
    confidence: str = "medium"
    fixed_sql: str | None = None


class SqlFixResult(BaseModel):
    success: bool
    original_sql: str
    fixed_sql: str | None = None
    error_message: str
    suggestions: list[SqlFixSuggestion] = Field(default_factory=list)
    suggestion_count: int = 0


# --- SQL Autocomplete ---


class SqlAutocompleteParams(BaseModel):
    prefix: str
    position: str = "any"
    warehouse: str | None = None
    table_context: list[str] | None = None
    limit: int = 20


class SqlAutocompleteSuggestion(BaseModel):
    name: str
    type: str  # table, column, schema
    detail: str | None = None
    fqn: str | None = None
    table: str | None = None
    warehouse: str | None = None
    in_context: bool = False


class SqlAutocompleteResult(BaseModel):
    suggestions: list[SqlAutocompleteSuggestion] = Field(default_factory=list)
    prefix: str
    position: str
    suggestion_count: int = 0


# --- Lineage ---


class LineageCheckParams(BaseModel):
    sql: str
    dialect: str | None = None
    schema_context: dict[str, list[ModelColumn]] | None = None


class LineageEdge(BaseModel):
    source_table: str
    source_column: str
    target_table: str
    target_column: str
    transform: str | None = None


class LineageCheckResult(BaseModel):
    edges: list[LineageEdge] = Field(default_factory=list)
    tables: list[str] = Field(default_factory=list)
    columns: list[str] = Field(default_factory=list)
    confidence: str = "high"
    confidence_factors: list[str] = Field(default_factory=list)


# --- Schema ---


class SchemaInspectParams(BaseModel):
    table: str
    schema_name: str | None = None
    warehouse: str | None = None


class SchemaColumn(BaseModel):
    name: str
    data_type: str
    nullable: bool = True
    primary_key: bool = False
    description: str | None = None


class SchemaInspectResult(BaseModel):
    table: str
    schema_name: str | None = None
    columns: list[SchemaColumn] = Field(default_factory=list)
    row_count: int | None = None


# --- Schema Cache (Indexing & Search) ---


class SchemaIndexParams(BaseModel):
    warehouse: str


class SchemaIndexResult(BaseModel):
    warehouse: str
    type: str
    schemas_indexed: int
    tables_indexed: int
    columns_indexed: int
    timestamp: str


class SchemaSearchTableResult(BaseModel):
    warehouse: str
    database: str | None = None
    schema_name: str = Field(alias="schema")
    name: str
    type: str = "TABLE"
    row_count: int | None = None
    fqn: str

    model_config = {"populate_by_name": True}


class SchemaSearchColumnResult(BaseModel):
    warehouse: str
    database: str | None = None
    schema_name: str = Field(alias="schema")
    table: str
    name: str
    data_type: str | None = None
    nullable: bool = True
    fqn: str

    model_config = {"populate_by_name": True}


class SchemaSearchParams(BaseModel):
    query: str
    warehouse: str | None = None
    limit: int = 20


class SchemaSearchResult(BaseModel):
    tables: list[SchemaSearchTableResult] = Field(default_factory=list)
    columns: list[SchemaSearchColumnResult] = Field(default_factory=list)
    query: str
    match_count: int = 0


class SchemaCacheWarehouseStatus(BaseModel):
    name: str
    type: str
    last_indexed: str | None = None
    databases_count: int = 0
    schemas_count: int = 0
    tables_count: int = 0
    columns_count: int = 0


class SchemaCacheStatusParams(BaseModel):
    pass


class SchemaCacheStatusResult(BaseModel):
    warehouses: list[SchemaCacheWarehouseStatus] = Field(default_factory=list)
    total_tables: int = 0
    total_columns: int = 0
    cache_path: str


# --- dbt ---


class DbtRunParams(BaseModel):
    command: str = "run"
    select: str | None = None
    args: list[str] = Field(default_factory=list)
    project_dir: str | None = None


class DbtRunResult(BaseModel):
    stdout: str
    stderr: str
    exit_code: int


class DbtManifestParams(BaseModel):
    path: str


class DbtModelInfo(BaseModel):
    unique_id: str
    name: str
    schema_name: str | None = None
    database: str | None = None
    materialized: str | None = None
    depends_on: list[str] = Field(default_factory=list)
    columns: list[ModelColumn] = Field(default_factory=list)


class DbtSourceInfo(BaseModel):
    unique_id: str
    name: str
    source_name: str
    schema_name: str | None = None
    database: str | None = None
    columns: list[ModelColumn] = Field(default_factory=list)


class DbtManifestResult(BaseModel):
    models: list[DbtModelInfo] = Field(default_factory=list)
    sources: list[DbtSourceInfo] = Field(default_factory=list)
    source_count: int = 0
    model_count: int = 0
    test_count: int = 0
    snapshot_count: int = 0
    seed_count: int = 0


# --- dbt Lineage ---


class DbtLineageParams(BaseModel):
    manifest_path: str
    model: str
    dialect: str | None = None


class DbtLineageResult(BaseModel):
    model_name: str
    model_unique_id: str | None = None
    compiled_sql: str | None = None
    raw_lineage: dict[str, Any] = Field(default_factory=dict)
    confidence: str = "high"
    confidence_factors: list[str] = Field(default_factory=list)


# --- dbt Profile Discovery ---


class DbtProfilesParams(BaseModel):
    path: str | None = None


class DbtProfileConnection(BaseModel):
    name: str
    type: str
    config: dict[str, Any] = Field(default_factory=dict)


class DbtProfilesResult(BaseModel):
    success: bool
    connections: list[DbtProfileConnection] = Field(default_factory=list)
    connection_count: int = 0
    error: str | None = None


# --- Local Schema Sync ---


class LocalSchemaSyncParams(BaseModel):
    warehouse: str
    target_path: str = ":memory:"
    schemas: list[str] | None = None
    sample_rows: int = 0
    limit: int | None = None


class LocalSchemaSyncResult(BaseModel):
    success: bool
    warehouse: str | None = None
    target_path: str | None = None
    tables_synced: int = 0
    columns_synced: int = 0
    schemas_synced: int = 0
    errors: list[str] | None = None
    error: str | None = None


# --- Local SQL Test ---


class LocalTestParams(BaseModel):
    sql: str
    target_path: str = ":memory:"
    target_dialect: str | None = None


class LocalTestResult(BaseModel):
    success: bool
    row_count: int = 0
    columns: list[str] = Field(default_factory=list)
    sample_rows: list[dict[str, Any]] = Field(default_factory=list)
    transpiled: bool = False
    transpile_warnings: list[str] | None = None
    error: str | None = None


# --- Warehouse ---


class WarehouseInfo(BaseModel):
    name: str
    type: str
    database: str | None = None


class WarehouseListParams(BaseModel):
    pass


class WarehouseListResult(BaseModel):
    warehouses: list[WarehouseInfo] = Field(default_factory=list)


class WarehouseTestParams(BaseModel):
    name: str


class WarehouseTestResult(BaseModel):
    connected: bool
    error: str | None = None

# --- Warehouse Management ---


class WarehouseAddParams(BaseModel):
    name: str
    config: dict[str, Any]


class WarehouseAddResult(BaseModel):
    success: bool
    name: str
    type: str
    error: str | None = None


class WarehouseRemoveParams(BaseModel):
    name: str


class WarehouseRemoveResult(BaseModel):
    success: bool
    error: str | None = None


class DockerContainer(BaseModel):
    container_id: str
    name: str
    image: str
    db_type: str
    host: str
    port: int
    user: str | None = None
    password: str | None = None
    database: str | None = None
    status: str


class WarehouseDiscoverResult(BaseModel):
    containers: list[DockerContainer] = Field(default_factory=list)
    container_count: int = 0
    error: str | None = None

# --- FinOps: Query History ---


class QueryHistoryParams(BaseModel):
    warehouse: str
    days: int = 7
    limit: int = 100
    user: str | None = None
    warehouse_filter: str | None = None


class QueryHistoryResult(BaseModel):
    success: bool
    queries: list[dict[str, Any]] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    warehouse_type: str | None = None
    error: str | None = None


# --- FinOps: Credit Analysis ---


class CreditAnalysisParams(BaseModel):
    warehouse: str
    days: int = 30
    limit: int = 50
    warehouse_filter: str | None = None


class CreditAnalysisResult(BaseModel):
    success: bool
    daily_usage: list[dict[str, Any]] = Field(default_factory=list)
    warehouse_summary: list[dict[str, Any]] = Field(default_factory=list)
    total_credits: float = 0
    days_analyzed: int = 0
    recommendations: list[dict[str, Any]] = Field(default_factory=list)
    error: str | None = None


# --- FinOps: Expensive Queries ---


class ExpensiveQueriesParams(BaseModel):
    warehouse: str
    days: int = 7
    limit: int = 20


class ExpensiveQueriesResult(BaseModel):
    success: bool
    queries: list[dict[str, Any]] = Field(default_factory=list)
    query_count: int = 0
    days_analyzed: int = 0
    error: str | None = None


# --- FinOps: Warehouse Advisor ---


class WarehouseAdvisorParams(BaseModel):
    warehouse: str
    days: int = 14


class WarehouseAdvisorResult(BaseModel):
    success: bool
    warehouse_load: list[dict[str, Any]] = Field(default_factory=list)
    warehouse_performance: list[dict[str, Any]] = Field(default_factory=list)
    recommendations: list[dict[str, Any]] = Field(default_factory=list)
    days_analyzed: int = 0
    error: str | None = None


# --- FinOps: Unused Resources ---


class UnusedResourcesParams(BaseModel):
    warehouse: str
    days: int = 30
    limit: int = 50


class UnusedResourcesResult(BaseModel):
    success: bool
    unused_tables: list[dict[str, Any]] = Field(default_factory=list)
    idle_warehouses: list[dict[str, Any]] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    days_analyzed: int = 0
    errors: list[str] | None = None
    error: str | None = None


# --- FinOps: Role & Access ---


class RoleGrantsParams(BaseModel):
    warehouse: str
    role: str | None = None
    object_name: str | None = None
    limit: int = 100


class RoleGrantsResult(BaseModel):
    success: bool
    grants: list[dict[str, Any]] = Field(default_factory=list)
    grant_count: int = 0
    privilege_summary: dict[str, int] = Field(default_factory=dict)
    error: str | None = None


class RoleHierarchyParams(BaseModel):
    warehouse: str


class RoleHierarchyResult(BaseModel):
    success: bool
    hierarchy: list[dict[str, Any]] = Field(default_factory=list)
    role_count: int = 0
    error: str | None = None


class UserRolesParams(BaseModel):
    warehouse: str
    user: str | None = None
    limit: int = 100


class UserRolesResult(BaseModel):
    success: bool
    assignments: list[dict[str, Any]] = Field(default_factory=list)
    assignment_count: int = 0
    error: str | None = None


# --- Schema: PII Detection ---


class PiiDetectParams(BaseModel):
    warehouse: str | None = None
    schema_name: str | None = None
    table: str | None = None


class PiiFinding(BaseModel):
    warehouse: str
    schema_name: str = Field(alias="schema")
    table: str
    column: str
    data_type: str | None = None
    pii_category: str
    confidence: str


class PiiDetectResult(BaseModel):
    success: bool
    findings: list[PiiFinding] = Field(default_factory=list)
    finding_count: int = 0
    columns_scanned: int = 0
    by_category: dict[str, int] = Field(default_factory=dict)
    tables_with_pii: int = 0


# --- Schema: Metadata Tags ---


class TagsGetParams(BaseModel):
    warehouse: str
    object_name: str | None = None
    tag_name: str | None = None
    limit: int = 100


class TagsGetResult(BaseModel):
    success: bool
    tags: list[dict[str, Any]] = Field(default_factory=list)
    tag_count: int = 0
    tag_summary: dict[str, int] = Field(default_factory=dict)
    error: str | None = None


class TagsListParams(BaseModel):
    warehouse: str
    limit: int = 50


class TagsListResult(BaseModel):
    success: bool
    tags: list[dict[str, Any]] = Field(default_factory=list)
    tag_count: int = 0
    error: str | None = None


# --- SQL Diff ---


class SqlDiffParams(BaseModel):
    original: str
    modified: str
    context_lines: int = 3


class SqlDiffResult(BaseModel):
    has_changes: bool
    unified_diff: str = ""
    additions: int = 0
    deletions: int = 0
    change_count: int = 0
    similarity: float = 1.0
    changes: list[dict[str, Any]] = Field(default_factory=list)
    semantic_equivalent: bool | None = None


# --- SQL Rewrite ---


class SqlRewriteRule(BaseModel):
    rule: str  # "SELECT_STAR", "NON_SARGABLE", "LARGE_IN_LIST"
    original_fragment: str
    rewritten_fragment: str
    explanation: str
    can_auto_apply: bool = True


class SqlRewriteParams(BaseModel):
    sql: str
    dialect: str = "snowflake"
    schema_context: dict[str, Any] | None = None


class SqlRewriteResult(BaseModel):
    success: bool
    original_sql: str
    rewritten_sql: str | None = None
    rewrites_applied: list[SqlRewriteRule] = Field(default_factory=list)
    error: str | None = None


# --- Schema Change Detection ---


class ColumnChange(BaseModel):
    column: str
    change_type: str  # "DROPPED", "ADDED", "TYPE_CHANGED", "RENAMED"
    severity: str  # "breaking", "warning", "info"
    message: str
    old_type: str | None = None
    new_type: str | None = None
    new_name: str | None = None


class SchemaDiffParams(BaseModel):
    old_sql: str
    new_sql: str
    dialect: str = "snowflake"
    schema_context: dict[str, Any] | None = None


class SchemaDiffResult(BaseModel):
    success: bool
    changes: list[ColumnChange] = Field(default_factory=list)
    has_breaking_changes: bool = False
    summary: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


# --- altimate_core ---


class AltimateCoreValidateParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreLintParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreSafetyParams(BaseModel):
    sql: str


class AltimateCoreTranspileParams(BaseModel):
    sql: str
    from_dialect: str
    to_dialect: str


class AltimateCoreExplainParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreCheckParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreResult(BaseModel):
    success: bool = True
    data: dict[str, Any] | None = Field(default_factory=dict)
    error: str | None = None


# --- altimate_core Phase 1 (P0) ---


class AltimateCoreFixParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None
    max_iterations: int = 5


class AltimateCorePolicyParams(BaseModel):
    sql: str
    policy_json: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreSemanticsParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreTestgenParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


# --- altimate_core Phase 2 (P1) ---


class AltimateCoreEquivalenceParams(BaseModel):
    sql1: str
    sql2: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreMigrationParams(BaseModel):
    old_ddl: str
    new_ddl: str
    dialect: str = ""


class AltimateCoreSchemaDiffParams(BaseModel):
    schema1_path: str = ""
    schema2_path: str = ""
    schema1_context: dict[str, Any] | None = None
    schema2_context: dict[str, Any] | None = None


class AltimateCoreGuardRewriteParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreCorrectParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreGradeParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


# --- altimate_core Phase 3 (P2) ---


class AltimateCoreClassifyPiiParams(BaseModel):
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreQueryPiiParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreResolveTermParams(BaseModel):
    term: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreColumnLineageParams(BaseModel):
    sql: str
    dialect: str = ""
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreTrackLineageParams(BaseModel):
    queries: list[str]
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreFormatSqlParams(BaseModel):
    sql: str
    dialect: str = ""


class AltimateCoreExtractMetadataParams(BaseModel):
    sql: str
    dialect: str = ""


class AltimateCoreCompareQueriesParams(BaseModel):
    left_sql: str
    right_sql: str
    dialect: str = ""


class AltimateCoreCompleteParams(BaseModel):
    sql: str
    cursor_pos: int
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreOptimizeContextParams(BaseModel):
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreOptimizeForQueryParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCorePruneSchemaParams(BaseModel):
    sql: str
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreImportDdlParams(BaseModel):
    ddl: str
    dialect: str = ""


class AltimateCoreExportDdlParams(BaseModel):
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreSchemaFingerprintParams(BaseModel):
    schema_path: str = ""
    schema_context: dict[str, Any] | None = None


class AltimateCoreIntrospectionSqlParams(BaseModel):
    db_type: str
    database: str
    schema_name: str | None = None


class AltimateCoreParseDbtProjectParams(BaseModel):
    project_dir: str


class AltimateCoreIsSafeParams(BaseModel):
    sql: str


# --- JSON-RPC ---


class JsonRpcRequest(BaseModel):
    jsonrpc: str = "2.0"
    method: str
    params: dict[str, Any] | None = None
    id: int | str | None = None


class JsonRpcError(BaseModel):
    code: int
    message: str
    data: Any | None = None


class JsonRpcResponse(BaseModel):
    jsonrpc: str = "2.0"
    result: Any | None = None
    error: JsonRpcError | None = None
    id: int | str | None = None
