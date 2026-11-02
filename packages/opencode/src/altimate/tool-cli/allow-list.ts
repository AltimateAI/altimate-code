// Explicit allow-list of the tools `altimate-code tool` exposes. A tool that is not listed here is not
// reachable from the CLI, so new tools are unavailable until added on purpose. Coding tools, the
// model-backed dbt_pr_review, memory/training tools, datamate_manager, mcp_discover, feedback_submit,
// sample_setup and tool_lookup are deliberately absent.
import type { Effect } from "effect"
import type { Agent } from "../../agent/agent"
import type { Tool } from "../../tool/tool"
import type { Truncate } from "../../tool/truncate"

import { AltimateCoreCheckTool } from "../tools/altimate-core-check"
import { AltimateCoreClassifyPiiTool } from "../tools/altimate-core-classify-pii"
import { AltimateCoreColumnLineageTool } from "../tools/altimate-core-column-lineage"
import { AltimateCoreCompareTool } from "../tools/altimate-core-compare"
import { AltimateCoreCompleteTool } from "../tools/altimate-core-complete"
import { AltimateCoreCorrectTool } from "../tools/altimate-core-correct"
import { AltimateCoreEquivalenceTool } from "../tools/altimate-core-equivalence"
import { AltimateCoreExportDdlTool } from "../tools/altimate-core-export-ddl"
import { AltimateCoreExtractMetadataTool } from "../tools/altimate-core-extract-metadata"
import { AltimateCoreFingerprintTool } from "../tools/altimate-core-fingerprint"
import { AltimateCoreFixTool } from "../tools/altimate-core-fix"
import { AltimateCoreGradeTool } from "../tools/altimate-core-grade"
import { AltimateCoreImportDdlTool } from "../tools/altimate-core-import-ddl"
import { AltimateCoreIntrospectionSqlTool } from "../tools/altimate-core-introspection-sql"
import { AltimateCoreMigrationTool } from "../tools/altimate-core-migration"
import { AltimateCoreOptimizeContextTool } from "../tools/altimate-core-optimize-context"
import { AltimateCoreParseDbtTool } from "../tools/altimate-core-parse-dbt"
import { AltimateCorePolicyTool } from "../tools/altimate-core-policy"
import { AltimateCorePruneSchemaTool } from "../tools/altimate-core-prune-schema"
import { AltimateCoreQueryPiiTool } from "../tools/altimate-core-query-pii"
import { AltimateCoreResolveTermTool } from "../tools/altimate-core-resolve-term"
import { AltimateCoreRewriteTool } from "../tools/altimate-core-rewrite"
import { AltimateCoreSchemaDiffTool } from "../tools/altimate-core-schema-diff"
import { AltimateCoreSemanticsTool } from "../tools/altimate-core-semantics"
import { AltimateCoreTestgenTool } from "../tools/altimate-core-testgen"
import { AltimateCoreTrackLineageTool } from "../tools/altimate-core-track-lineage"
import { AltimateCoreValidateTool } from "../tools/altimate-core-validate"
import { DataDiffTool } from "../tools/data-diff"
import { DbtLineageTool } from "../tools/dbt-lineage"
import { DbtManifestTool } from "../tools/dbt-manifest"
import { DbtProfilesTool } from "../tools/dbt-profiles"
import { DbtUnitTestGenTool } from "../tools/dbt-unit-test-gen"
import { FinopsAnalyzeCreditsTool } from "../tools/finops-analyze-credits"
import { FinopsExpensiveQueriesTool } from "../tools/finops-expensive-queries"
import { FinopsQueryHistoryTool } from "../tools/finops-query-history"
import { FinopsRoleGrantsTool, FinopsRoleHierarchyTool, FinopsUserRolesTool } from "../tools/finops-role-access"
import { FinopsUnusedResourcesTool } from "../tools/finops-unused-resources"
import { FinopsWarehouseAdviceTool } from "../tools/finops-warehouse-advice"
import { ImpactAnalysisTool } from "../tools/impact-analysis"
import { LineageCheckTool } from "../tools/lineage-check"
import { ProjectScanTool } from "../tools/project-scan"
import { SchemaCacheStatusTool } from "../tools/schema-cache-status"
import { SchemaDetectPiiTool } from "../tools/schema-detect-pii"
import { SchemaDiffTool } from "../tools/schema-diff"
import { SchemaIndexTool } from "../tools/schema-index"
import { SchemaInspectTool } from "../tools/schema-inspect"
import { SchemaSearchTool } from "../tools/schema-search"
import { SchemaTagsTool, SchemaTagsListTool } from "../tools/schema-tags"
import { SqlAnalyzeTool } from "../tools/sql-analyze"
import { SqlAutocompleteTool } from "../tools/sql-autocomplete"
import { SqlCheckTool } from "../tools/sql-check"
import { SqlDiffTool } from "../tools/sql-diff"
import { SqlExecuteTool } from "../tools/sql-execute"
import { SqlExplainTool } from "../tools/sql-explain"
import { SqlFixTool } from "../tools/sql-fix"
import { SqlFormatTool } from "../tools/sql-format"
import { SqlMaterializeTool } from "../tools/sql-materialize"
import { SqlOptimizeTool } from "../tools/sql-optimize"
import { SqlRewriteTool } from "../tools/sql-rewrite"
import { SqlTranslateTool } from "../tools/sql-translate"
import { WarehouseAddTool } from "../tools/warehouse-add"
import { WarehouseDiscoverTool } from "../tools/warehouse-discover"
import { WarehouseInstallDriverTool } from "../tools/warehouse-install-driver"
import { WarehouseListTool } from "../tools/warehouse-list"
import { WarehouseRemoveTool } from "../tools/warehouse-remove"
import { WarehouseTestTool } from "../tools/warehouse-test"
import { AnswerCommit } from "../tools/answer-commit"

type Source = Effect.Effect<Tool.Info<any, any>, never, Truncate.Service | Agent.Service>

export const EXPOSED: Record<string, Source> = {
  altimate_core_check: AltimateCoreCheckTool,
  altimate_core_classify_pii: AltimateCoreClassifyPiiTool,
  altimate_core_column_lineage: AltimateCoreColumnLineageTool,
  altimate_core_compare: AltimateCoreCompareTool,
  altimate_core_complete: AltimateCoreCompleteTool,
  altimate_core_correct: AltimateCoreCorrectTool,
  altimate_core_equivalence: AltimateCoreEquivalenceTool,
  altimate_core_export_ddl: AltimateCoreExportDdlTool,
  altimate_core_extract_metadata: AltimateCoreExtractMetadataTool,
  altimate_core_fingerprint: AltimateCoreFingerprintTool,
  altimate_core_fix: AltimateCoreFixTool,
  altimate_core_grade: AltimateCoreGradeTool,
  altimate_core_import_ddl: AltimateCoreImportDdlTool,
  altimate_core_introspection_sql: AltimateCoreIntrospectionSqlTool,
  altimate_core_migration: AltimateCoreMigrationTool,
  altimate_core_optimize_context: AltimateCoreOptimizeContextTool,
  altimate_core_parse_dbt: AltimateCoreParseDbtTool,
  altimate_core_policy: AltimateCorePolicyTool,
  altimate_core_prune_schema: AltimateCorePruneSchemaTool,
  altimate_core_query_pii: AltimateCoreQueryPiiTool,
  altimate_core_resolve_term: AltimateCoreResolveTermTool,
  altimate_core_rewrite: AltimateCoreRewriteTool,
  altimate_core_schema_diff: AltimateCoreSchemaDiffTool,
  altimate_core_semantics: AltimateCoreSemanticsTool,
  altimate_core_testgen: AltimateCoreTestgenTool,
  altimate_core_track_lineage: AltimateCoreTrackLineageTool,
  altimate_core_validate: AltimateCoreValidateTool,
  data_diff: DataDiffTool,
  dbt_lineage: DbtLineageTool,
  dbt_manifest: DbtManifestTool,
  dbt_profiles: DbtProfilesTool,
  dbt_unit_test_gen: DbtUnitTestGenTool,
  finops_analyze_credits: FinopsAnalyzeCreditsTool,
  finops_expensive_queries: FinopsExpensiveQueriesTool,
  finops_query_history: FinopsQueryHistoryTool,
  finops_role_grants: FinopsRoleGrantsTool,
  finops_role_hierarchy: FinopsRoleHierarchyTool,
  finops_user_roles: FinopsUserRolesTool,
  finops_unused_resources: FinopsUnusedResourcesTool,
  finops_warehouse_advice: FinopsWarehouseAdviceTool,
  impact_analysis: ImpactAnalysisTool,
  lineage_check: LineageCheckTool,
  project_scan: ProjectScanTool,
  schema_cache_status: SchemaCacheStatusTool,
  schema_detect_pii: SchemaDetectPiiTool,
  schema_diff: SchemaDiffTool,
  schema_index: SchemaIndexTool,
  schema_inspect: SchemaInspectTool,
  schema_search: SchemaSearchTool,
  schema_tags: SchemaTagsTool,
  schema_tags_list: SchemaTagsListTool,
  sql_analyze: SqlAnalyzeTool,
  sql_autocomplete: SqlAutocompleteTool,
  sql_check: SqlCheckTool,
  sql_diff: SqlDiffTool,
  sql_execute: SqlExecuteTool,
  sql_explain: SqlExplainTool,
  sql_fix: SqlFixTool,
  sql_format: SqlFormatTool,
  sql_materialize: SqlMaterializeTool,
  sql_optimize: SqlOptimizeTool,
  sql_rewrite: SqlRewriteTool,
  sql_translate: SqlTranslateTool,
  warehouse_add: WarehouseAddTool,
  warehouse_discover: WarehouseDiscoverTool,
  warehouse_install_driver: WarehouseInstallDriverTool,
  warehouse_list: WarehouseListTool,
  warehouse_remove: WarehouseRemoveTool,
  warehouse_test: WarehouseTestTool,
  answer_commit: AnswerCommit.AnswerCommitTool,
}

/** Tools that change local configuration or install software; these need `--allow-write`. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["warehouse_add", "warehouse_remove", "warehouse_install_driver"])
/** Write tools that stay available read-only over MCP: warehouse_add is part of the default lean toolset. */
export const MCP_OPEN_WRITE_TOOLS: ReadonlySet<string> = new Set(["warehouse_add"])
