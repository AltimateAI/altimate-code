/**
 * Carry-forward regression guard: the fork's altimate tools survived the
 * OpenCode v1.17.9 upstream merge.
 *
 * Each `*Tool` is built via `Tool.define(id, ...)`, which `Object.assign`s a
 * static `.id` onto the returned Effect (src/tool/tool.ts). We assert the
 * static id WITHOUT booting the tool registry / Instance — that boot path hits
 * a known dual-DB migration race in this branch (see tool-lookup.test.ts), so
 * a registry round-trip is not reliable here. The static id is exactly what
 * the registry would register, so this is the high-signal carry-forward check.
 */
import { describe, test, expect } from "bun:test"

// SQL analysis tools
import { SqlAnalyzeTool } from "../../../src/altimate/tools/sql-analyze"
import { SqlOptimizeTool } from "../../../src/altimate/tools/sql-optimize"
import { SqlTranslateTool } from "../../../src/altimate/tools/sql-translate"
import { SqlRewriteTool } from "../../../src/altimate/tools/sql-rewrite"
import { SqlFixTool } from "../../../src/altimate/tools/sql-fix"
import { SqlFormatTool } from "../../../src/altimate/tools/sql-format"
import { SqlExplainTool } from "../../../src/altimate/tools/sql-explain"
import { SqlExecuteTool } from "../../../src/altimate/tools/sql-execute"
import { SqlAutocompleteTool } from "../../../src/altimate/tools/sql-autocomplete"
import { SqlDiffTool } from "../../../src/altimate/tools/sql-diff"

// Schema tools
import { SchemaInspectTool } from "../../../src/altimate/tools/schema-inspect"
import { SchemaIndexTool } from "../../../src/altimate/tools/schema-index"
import { SchemaSearchTool } from "../../../src/altimate/tools/schema-search"
import { SchemaCacheStatusTool } from "../../../src/altimate/tools/schema-cache-status"
import { SchemaDetectPiiTool } from "../../../src/altimate/tools/schema-detect-pii"
import { SchemaDiffTool } from "../../../src/altimate/tools/schema-diff"
import { SchemaTagsTool, SchemaTagsListTool } from "../../../src/altimate/tools/schema-tags"

// FinOps tools
import { FinopsQueryHistoryTool } from "../../../src/altimate/tools/finops-query-history"
import { FinopsAnalyzeCreditsTool } from "../../../src/altimate/tools/finops-analyze-credits"
import { FinopsExpensiveQueriesTool } from "../../../src/altimate/tools/finops-expensive-queries"
import { FinopsWarehouseAdviceTool } from "../../../src/altimate/tools/finops-warehouse-advice"
import { FinopsUnusedResourcesTool } from "../../../src/altimate/tools/finops-unused-resources"

// dbt tools
import { DbtManifestTool } from "../../../src/altimate/tools/dbt-manifest"
import { DbtLineageTool } from "../../../src/altimate/tools/dbt-lineage"
import { DbtProfilesTool } from "../../../src/altimate/tools/dbt-profiles"
import { DbtUnitTestGenTool } from "../../../src/altimate/tools/dbt-unit-test-gen"
import { DbtPrReviewTool } from "../../../src/altimate/tools/dbt-pr-review"

// Warehouse / connection tools
import { WarehouseListTool } from "../../../src/altimate/tools/warehouse-list"
import { WarehouseAddTool } from "../../../src/altimate/tools/warehouse-add"
import { WarehouseRemoveTool } from "../../../src/altimate/tools/warehouse-remove"
import { WarehouseTestTool } from "../../../src/altimate/tools/warehouse-test"
import { WarehouseDiscoverTool } from "../../../src/altimate/tools/warehouse-discover"
import { DataDiffTool } from "../../../src/altimate/tools/data-diff"

// altimate-core engine bridge tools (sampling of the 27)
import { AltimateCoreCheckTool } from "../../../src/altimate/tools/altimate-core-check"
import { AltimateCoreEquivalenceTool } from "../../../src/altimate/tools/altimate-core-equivalence"
import { AltimateCoreRewriteTool } from "../../../src/altimate/tools/altimate-core-rewrite"
import { AltimateCoreGradeTool } from "../../../src/altimate/tools/altimate-core-grade"

// Training tools
import { TrainingSaveTool } from "../../../src/altimate/tools/training-save"
import { TrainingListTool } from "../../../src/altimate/tools/training-list"

describe("carry-forward: altimate tools present with stable ids", () => {
  test("SQL analysis tools keep their ids", () => {
    expect(SqlAnalyzeTool.id).toBe("sql_analyze")
    expect(SqlOptimizeTool.id).toBe("sql_optimize")
    expect(SqlTranslateTool.id).toBe("sql_translate")
    expect(SqlRewriteTool.id).toBe("sql_rewrite")
    expect(SqlFixTool.id).toBe("sql_fix")
    expect(SqlFormatTool.id).toBe("sql_format")
    expect(SqlExplainTool.id).toBe("sql_explain")
    expect(SqlExecuteTool.id).toBe("sql_execute")
    expect(SqlAutocompleteTool.id).toBe("sql_autocomplete")
    expect(SqlDiffTool.id).toBe("sql_diff")
  })

  test("schema tools keep their ids", () => {
    expect(SchemaInspectTool.id).toBe("schema_inspect")
    expect(SchemaIndexTool.id).toBe("schema_index")
    expect(SchemaSearchTool.id).toBe("schema_search")
    expect(SchemaCacheStatusTool.id).toBe("schema_cache_status")
    expect(SchemaDetectPiiTool.id).toBe("schema_detect_pii")
    expect(SchemaDiffTool.id).toBe("schema_diff")
    expect(SchemaTagsTool.id).toBe("schema_tags")
    expect(SchemaTagsListTool.id).toBe("schema_tags_list")
  })

  test("finops tools keep their ids", () => {
    expect(FinopsQueryHistoryTool.id).toBe("finops_query_history")
    expect(FinopsAnalyzeCreditsTool.id).toBe("finops_analyze_credits")
    expect(FinopsExpensiveQueriesTool.id).toBe("finops_expensive_queries")
    expect(FinopsWarehouseAdviceTool.id).toBe("finops_warehouse_advice")
    expect(FinopsUnusedResourcesTool.id).toBe("finops_unused_resources")
  })

  test("dbt tools keep their ids (incl. dbt_pr_review engine)", () => {
    expect(DbtManifestTool.id).toBe("dbt_manifest")
    expect(DbtLineageTool.id).toBe("dbt_lineage")
    expect(DbtProfilesTool.id).toBe("dbt_profiles")
    expect(DbtUnitTestGenTool.id).toBe("dbt_unit_test_gen")
    expect(DbtPrReviewTool.id).toBe("dbt_pr_review")
  })

  test("warehouse / connection tools keep their ids", () => {
    expect(WarehouseListTool.id).toBe("warehouse_list")
    expect(WarehouseAddTool.id).toBe("warehouse_add")
    expect(WarehouseRemoveTool.id).toBe("warehouse_remove")
    expect(WarehouseTestTool.id).toBe("warehouse_test")
    expect(WarehouseDiscoverTool.id).toBe("warehouse_discover")
    expect(DataDiffTool.id).toBe("data_diff")
  })

  test("altimate-core engine bridge tools keep their ids", () => {
    expect(AltimateCoreCheckTool.id).toBe("altimate_core_check")
    expect(AltimateCoreEquivalenceTool.id).toBe("altimate_core_equivalence")
    expect(AltimateCoreRewriteTool.id).toBe("altimate_core_rewrite")
    expect(AltimateCoreGradeTool.id).toBe("altimate_core_grade")
  })

  test("training tools keep their ids", () => {
    expect(TrainingSaveTool.id).toBe("training_save")
    expect(TrainingListTool.id).toBe("training_list")
  })

  test("every tool id is unique across categories", () => {
    const ids = [
      SqlAnalyzeTool.id,
      SqlOptimizeTool.id,
      SchemaInspectTool.id,
      FinopsQueryHistoryTool.id,
      DbtPrReviewTool.id,
      WarehouseListTool.id,
      AltimateCoreCheckTool.id,
      TrainingSaveTool.id,
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })
})
