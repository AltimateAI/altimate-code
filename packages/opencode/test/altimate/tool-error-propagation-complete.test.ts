/**
 * Tests error propagation for ALL altimate-core tool wrappers.
 *
 * Covers the 20 tools that were missing error propagation (Issue #1),
 * plus targeted fixes for impact-analysis (Issue #2), sql-fix (Issue #8),
 * complete/grade ?? {} guard (Issue #11), and lineage-check.
 *
 * Each test verifies:
 * 1. Success path: result.error propagates to metadata.error
 * 2. Data error: data.error propagates to metadata.error
 * 3. Catch path: exception message propagates to metadata.error
 * 4. Clean path: no error key when everything succeeds
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test"
import { initTool } from "./tool-fixture"
import * as Dispatcher from "../../src/altimate/native/dispatcher"

beforeAll(async () => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
  // Import native/index.ts to set the lazy registration hook, then consume it.
  // This prevents the hook from firing during tool.execute() and overwriting mocks.
  await import("../../src/altimate/native/index")
  try {
    await Dispatcher.call("__trigger_hook__" as any, {} as any)
  } catch {}
  Dispatcher.reset()
})
afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

function stubCtx(): any {
  return {
    sessionID: "test",
    messageID: "test",
    agent: "test",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  }
}

function telemetryWouldExtract(metadata: Record<string, any>): string {
  return typeof metadata?.error === "string" ? metadata.error : "unknown error"
}

// ---------------------------------------------------------------------------
// Helper: test a tool for all 3 error paths + clean path
// ---------------------------------------------------------------------------
function describeToolErrorPropagation(opts: {
  name: string
  dispatcherMethod: string
  importPath: string
  exportName: string
  args: Record<string, any>
  successResponse: Record<string, any>
  dataErrorResponse: Record<string, any>
}) {
  describe(`${opts.name} error propagation`, () => {
    beforeEach(() => Dispatcher.reset())

    test("propagates result.error to metadata", async () => {
      Dispatcher.register(opts.dispatcherMethod as any, async () => ({
        success: false,
        error: "Dispatcher-level failure",
        data: {},
      }))

      const mod = await import(opts.importPath)
      const tool = await initTool(mod[opts.exportName])
      const result = await tool.execute(opts.args, stubCtx())

      expect(result.metadata.error).toContain("Dispatcher-level failure")
      expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
    })

    test("propagates data.error to metadata", async () => {
      Dispatcher.register(opts.dispatcherMethod as any, async () => opts.dataErrorResponse)

      const mod = await import(opts.importPath)
      const tool = await initTool(mod[opts.exportName])
      const result = await tool.execute(opts.args, stubCtx())

      expect(result.metadata.error).toBeDefined()
      expect(typeof result.metadata.error).toBe("string")
      expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
    })

    test("propagates exception to metadata.error in catch", async () => {
      Dispatcher.register(opts.dispatcherMethod as any, async () => {
        throw new Error("Connection refused")
      })

      const mod = await import(opts.importPath)
      const tool = await initTool(mod[opts.exportName])
      const result = await tool.execute(opts.args, stubCtx())

      expect(result.metadata.success).toBe(false)
      expect(result.metadata.error).toBe("Connection refused")
      expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
    })

    test("no error key in metadata on clean success", async () => {
      Dispatcher.register(opts.dispatcherMethod as any, async () => opts.successResponse)

      const mod = await import(opts.importPath)
      const tool = await initTool(mod[opts.exportName])
      const result = await tool.execute(opts.args, stubCtx())

      expect(result.metadata.error).toBeUndefined()
    })
  })
}

// ---------------------------------------------------------------------------
// The 20 previously-untreated altimate-core tools
// ---------------------------------------------------------------------------

describeToolErrorPropagation({
  name: "altimate_core_check",
  dispatcherMethod: "altimate_core.check",
  importPath: "../../src/altimate/tools/altimate-core-check",
  exportName: "AltimateCoreCheckTool",
  args: { sql: "SELECT 1", dialect: "snowflake" },
  successResponse: {
    success: true,
    data: { validation: { valid: true }, lint: { clean: true }, safety: { safe: true }, pii: { findings: [] } },
  },
  dataErrorResponse: { success: true, data: { error: "Internal check engine failure" } },
})

describeToolErrorPropagation({
  name: "altimate_core_classify_pii",
  dispatcherMethod: "altimate_core.classify_pii",
  importPath: "../../src/altimate/tools/altimate-core-classify-pii",
  exportName: "AltimateCoreClassifyPiiTool",
  args: { schema_context: { users: { id: "INT" } } },
  successResponse: { success: true, data: { columns: [], findings: [] } },
  dataErrorResponse: { success: true, data: { error: "Schema parse failed" } },
})

describeToolErrorPropagation({
  name: "altimate_core_column_lineage",
  dispatcherMethod: "altimate_core.column_lineage",
  importPath: "../../src/altimate/tools/altimate-core-column-lineage",
  exportName: "AltimateCoreColumnLineageTool",
  args: { sql: "SELECT id FROM users" },
  successResponse: { success: true, data: { column_lineage: [{ source: "users.id", target: "id" }] } },
  dataErrorResponse: { success: true, data: { error: "Failed to resolve table" } },
})

describeToolErrorPropagation({
  name: "altimate_core_compare",
  dispatcherMethod: "altimate_core.compare",
  importPath: "../../src/altimate/tools/altimate-core-compare",
  exportName: "AltimateCoreCompareTool",
  args: { left_sql: "SELECT 1", right_sql: "SELECT 2" },
  successResponse: { success: true, data: { differences: [] } },
  dataErrorResponse: { success: true, data: { error: "Parse failure in left SQL" } },
})

describeToolErrorPropagation({
  name: "altimate_core_export_ddl",
  dispatcherMethod: "altimate_core.export_ddl",
  importPath: "../../src/altimate/tools/altimate-core-export-ddl",
  exportName: "AltimateCoreExportDdlTool",
  args: { schema_context: { users: { id: "INT" } } },
  successResponse: { success: true, data: { ddl: "CREATE TABLE users (id INT)" } },
  dataErrorResponse: { success: true, data: { error: "No tables in schema" } },
})

describeToolErrorPropagation({
  name: "altimate_core_extract_metadata",
  dispatcherMethod: "altimate_core.metadata",
  importPath: "../../src/altimate/tools/altimate-core-extract-metadata",
  exportName: "AltimateCoreExtractMetadataTool",
  args: { sql: "SELECT id FROM users" },
  successResponse: { success: true, data: { tables: ["users"], columns: ["id"] } },
  dataErrorResponse: { success: true, data: { error: "Parse failure" } },
})

describeToolErrorPropagation({
  name: "altimate_core_fingerprint",
  dispatcherMethod: "altimate_core.fingerprint",
  importPath: "../../src/altimate/tools/altimate-core-fingerprint",
  exportName: "AltimateCoreFingerprintTool",
  args: { schema_context: { users: { id: "INT" } } },
  successResponse: { success: true, data: { fingerprint: "abc123def456" } },
  dataErrorResponse: { success: true, data: { error: "Empty schema" } },
})

describeToolErrorPropagation({
  name: "altimate_core_import_ddl",
  dispatcherMethod: "altimate_core.import_ddl",
  importPath: "../../src/altimate/tools/altimate-core-import-ddl",
  exportName: "AltimateCoreImportDdlTool",
  args: { ddl: "CREATE TABLE users (id INT)" },
  successResponse: { success: true, data: { schema: { users: { id: "INT" } } } },
  dataErrorResponse: { success: true, data: { error: "Invalid DDL syntax" } },
})

describeToolErrorPropagation({
  name: "altimate_core_introspection_sql",
  dispatcherMethod: "altimate_core.introspection_sql",
  importPath: "../../src/altimate/tools/altimate-core-introspection-sql",
  exportName: "AltimateCoreIntrospectionSqlTool",
  args: { db_type: "postgres", database: "mydb" },
  successResponse: { success: true, data: { queries: { tables: "SELECT * FROM information_schema.tables" } } },
  dataErrorResponse: { success: true, data: { error: "Unsupported database type" } },
})

describeToolErrorPropagation({
  name: "altimate_core_migration",
  dispatcherMethod: "altimate_core.migration",
  importPath: "../../src/altimate/tools/altimate-core-migration",
  exportName: "AltimateCoreMigrationTool",
  args: { old_ddl: "CREATE TABLE users (id INT)", new_ddl: "CREATE TABLE users (id BIGINT)" },
  successResponse: { success: true, data: { risks: [] } },
  dataErrorResponse: { success: true, data: { error: "Failed to parse old DDL" } },
})

describeToolErrorPropagation({
  name: "altimate_core_optimize_context",
  dispatcherMethod: "altimate_core.optimize_context",
  importPath: "../../src/altimate/tools/altimate-core-optimize-context",
  exportName: "AltimateCoreOptimizeContextTool",
  args: { schema_context: { users: { id: "INT" } } },
  successResponse: { success: true, data: { levels: [{ level: 1, tokens: 100 }] } },
  dataErrorResponse: { success: true, data: { error: "Schema too large" } },
})

describeToolErrorPropagation({
  name: "altimate_core_parse_dbt",
  dispatcherMethod: "altimate_core.parse_dbt",
  importPath: "../../src/altimate/tools/altimate-core-parse-dbt",
  exportName: "AltimateCoreParseDbtTool",
  args: { project_dir: "/tmp/fake" },
  successResponse: { success: true, data: { models: [{ name: "stg_users" }] } },
  dataErrorResponse: { success: true, data: { error: "dbt_project.yml not found" } },
})

describeToolErrorPropagation({
  name: "altimate_core_policy",
  dispatcherMethod: "altimate_core.policy",
  importPath: "../../src/altimate/tools/altimate-core-policy",
  exportName: "AltimateCorePolicyTool",
  args: { sql: "DELETE FROM users", policy_json: '{"rules": []}' },
  successResponse: { success: true, data: { pass: true, violations: [] } },
  dataErrorResponse: { success: true, data: { error: "Invalid policy JSON" } },
})

describeToolErrorPropagation({
  name: "altimate_core_prune_schema",
  dispatcherMethod: "altimate_core.prune_schema",
  importPath: "../../src/altimate/tools/altimate-core-prune-schema",
  exportName: "AltimateCorePruneSchemaTool",
  args: { sql: "SELECT 1", schema_context: { users: { id: "INT" } } },
  successResponse: { success: true, data: { relevant_tables: ["users"], tables_pruned: 0, total_tables: 1 } },
  dataErrorResponse: { success: true, data: { error: "SQL parse failure" } },
})

describeToolErrorPropagation({
  name: "altimate_core_query_pii",
  dispatcherMethod: "altimate_core.query_pii",
  importPath: "../../src/altimate/tools/altimate-core-query-pii",
  exportName: "AltimateCoreQueryPiiTool",
  args: { sql: "SELECT email FROM users", schema_context: { users: { email: "VARCHAR" } } },
  successResponse: { success: true, data: { pii_columns: [], exposures: [] } },
  dataErrorResponse: { success: true, data: { error: "PII classification unavailable" } },
})

describeToolErrorPropagation({
  name: "altimate_core_resolve_term",
  dispatcherMethod: "altimate_core.resolve_term",
  importPath: "../../src/altimate/tools/altimate-core-resolve-term",
  exportName: "AltimateCoreResolveTermTool",
  args: { term: "revenue", schema_context: { orders: { total: "DECIMAL" } } },
  successResponse: { success: true, data: { matches: [{ table: "orders", column: "total", confidence: 0.9 }] } },
  dataErrorResponse: { success: true, data: { error: "No schema loaded" } },
})

describeToolErrorPropagation({
  name: "altimate_core_rewrite",
  dispatcherMethod: "altimate_core.rewrite",
  importPath: "../../src/altimate/tools/altimate-core-rewrite",
  exportName: "AltimateCoreRewriteTool",
  args: { sql: "SELECT * FROM users" },
  successResponse: { success: true, data: { suggestions: [], rewrites: [] } },
  dataErrorResponse: { success: true, data: { error: "Rewrite engine unavailable" } },
})

describeToolErrorPropagation({
  name: "altimate_core_schema_diff",
  dispatcherMethod: "altimate_core.schema_diff",
  importPath: "../../src/altimate/tools/altimate-core-schema-diff",
  exportName: "AltimateCoreSchemaDiffTool",
  args: { schema1_context: { users: { id: "INT" } }, schema2_context: { users: { id: "BIGINT" } } },
  successResponse: { success: true, data: { changes: [], has_breaking_changes: false } },
  dataErrorResponse: { success: true, data: { error: "Schema1 parse failure" } },
})

describeToolErrorPropagation({
  name: "altimate_core_testgen",
  dispatcherMethod: "altimate_core.testgen",
  importPath: "../../src/altimate/tools/altimate-core-testgen",
  exportName: "AltimateCoreTestgenTool",
  args: { sql: "SELECT id FROM users" },
  successResponse: { success: true, data: { tests: [{ name: "boundary_test", sql: "SELECT 1" }] } },
  dataErrorResponse: { success: true, data: { error: "Test generation failed" } },
})

describeToolErrorPropagation({
  name: "altimate_core_track_lineage",
  dispatcherMethod: "altimate_core.track_lineage",
  importPath: "../../src/altimate/tools/altimate-core-track-lineage",
  exportName: "AltimateCoreTrackLineageTool",
  args: { queries: ["SELECT 1", "SELECT 2"] },
  successResponse: { success: true, data: { edges: [{ source: "a", target: "b" }] } },
  dataErrorResponse: { success: true, data: { error: "Lineage tracking failed" } },
})

// ---------------------------------------------------------------------------
// Issue #2: impact-analysis.ts catch block missing error in metadata
// ---------------------------------------------------------------------------
describe("impact_analysis catch error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("propagates exception to metadata.error in catch", async () => {
    Dispatcher.register("dbt.manifest" as any, async () => {
      throw new Error("Manifest not found")
    })

    const { ImpactAnalysisTool } = await import("../../src/altimate/tools/impact-analysis")
    const tool = await initTool(ImpactAnalysisTool)
    const result = await tool.execute(
      {
        model: "stg_orders",
        change_type: "remove" as const,
        manifest_path: "target/manifest.json",
        dialect: "snowflake",
      },
      stubCtx(),
    )

    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error).toBe("Manifest not found")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// Issue #8: sql-fix.ts unconditional error spread — no error key on success
// ---------------------------------------------------------------------------
describe("sql_fix conditional error spread", () => {
  beforeEach(() => Dispatcher.reset())

  test("no error key in metadata on successful fix", async () => {
    Dispatcher.register("sql.fix" as any, async () => ({
      success: true,
      error_message: "Column 'foo' not found",
      fixed_sql: "SELECT bar FROM t",
      suggestions: [{ type: "column_fix", confidence: "high", message: "Did you mean 'bar'?" }],
      suggestion_count: 1,
    }))

    const { SqlFixTool } = await import("../../src/altimate/tools/sql-fix")
    const tool = await initTool(SqlFixTool)
    const result = await tool.execute(
      { sql: "SELECT foo FROM t", error_message: "Column 'foo' not found", dialect: "snowflake" },
      stubCtx(),
    )

    expect(result.metadata.success).toBe(true)
    expect(result.metadata.error).toBeUndefined()
  })

  test("error key present when result.error exists", async () => {
    Dispatcher.register("sql.fix" as any, async () => ({
      success: false,
      error: "Parse failure",
      error_message: "",
      fixed_sql: null,
      suggestions: [],
      suggestion_count: 0,
    }))

    const { SqlFixTool } = await import("../../src/altimate/tools/sql-fix")
    const tool = await initTool(SqlFixTool)
    const result = await tool.execute({ sql: "SELCT", error_message: "syntax error", dialect: "snowflake" }, stubCtx())

    expect(result.metadata.error).toBe("Parse failure")
  })
})

// ---------------------------------------------------------------------------
// Issue #11: altimate_core_complete missing ?? {} guard
// ---------------------------------------------------------------------------
describe("altimate_core_complete null data guard", () => {
  beforeEach(() => Dispatcher.reset())

  test("handles null result.data without TypeError", async () => {
    Dispatcher.register("altimate_core.complete" as any, async () => ({
      success: false,
      error: "Engine crashed",
      data: null,
    }))

    const { AltimateCoreCompleteTool } = await import("../../src/altimate/tools/altimate-core-complete")
    const tool = await initTool(AltimateCoreCompleteTool)
    const result = await tool.execute({ sql: "SEL", cursor_pos: 3 }, stubCtx())

    expect(result.metadata.error).toBe("Engine crashed")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })

  test("handles undefined result.data without TypeError", async () => {
    Dispatcher.register("altimate_core.complete" as any, async () => ({
      success: false,
      error: "No handler",
    }))

    const { AltimateCoreCompleteTool } = await import("../../src/altimate/tools/altimate-core-complete")
    const tool = await initTool(AltimateCoreCompleteTool)
    const result = await tool.execute({ sql: "SEL", cursor_pos: 3 }, stubCtx())

    expect(result.metadata.error).toBe("No handler")
  })
})

// ---------------------------------------------------------------------------
// altimate_core_grade missing ?? {} guard
// ---------------------------------------------------------------------------
describe("altimate_core_grade null data guard", () => {
  beforeEach(() => Dispatcher.reset())

  test("handles null result.data without TypeError", async () => {
    Dispatcher.register("altimate_core.grade" as any, async () => ({
      success: false,
      error: "Grading engine unavailable",
      data: null,
    }))

    const { AltimateCoreGradeTool } = await import("../../src/altimate/tools/altimate-core-grade")
    const tool = await initTool(AltimateCoreGradeTool)
    const result = await tool.execute({ sql: "SELECT 1" }, stubCtx())

    expect(result.metadata.error).toBe("Grading engine unavailable")
    expect(telemetryWouldExtract(result.metadata)).not.toBe("unknown error")
  })
})

// ---------------------------------------------------------------------------
// lineage_check error propagation
// ---------------------------------------------------------------------------
describe("lineage_check error propagation", () => {
  beforeEach(() => Dispatcher.reset())

  test("propagates result.error to metadata", async () => {
    Dispatcher.register("lineage.check" as any, async () => ({
      success: false,
      error: "Lineage engine not initialized",
      data: {},
    }))

    const { LineageCheckTool } = await import("../../src/altimate/tools/lineage-check")
    const tool = await initTool(LineageCheckTool)
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, stubCtx())

    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error).toBe("Lineage engine not initialized")
  })

  test("propagates data.error to metadata on partial success", async () => {
    Dispatcher.register("lineage.check" as any, async () => ({
      success: true,
      data: { error: "Partial lineage: some tables unresolved", column_dict: {} },
    }))

    const { LineageCheckTool } = await import("../../src/altimate/tools/lineage-check")
    const tool = await initTool(LineageCheckTool)
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, stubCtx())

    expect(result.metadata.error).toContain("Partial lineage")
  })

  test("propagates exception to metadata.error in catch", async () => {
    Dispatcher.register("lineage.check" as any, async () => {
      throw new Error("NAPI crash")
    })

    const { LineageCheckTool } = await import("../../src/altimate/tools/lineage-check")
    const tool = await initTool(LineageCheckTool)
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, stubCtx())

    expect(result.metadata.success).toBe(false)
    expect(result.metadata.error).toBe("NAPI crash")
  })

  test("handles null result.data without TypeError", async () => {
    Dispatcher.register("lineage.check" as any, async () => ({
      success: false,
      error: "Engine crashed",
      data: null,
    }))

    const { LineageCheckTool } = await import("../../src/altimate/tools/lineage-check")
    const tool = await initTool(LineageCheckTool)
    const result = await tool.execute({ sql: "SELECT 1", dialect: "snowflake" }, stubCtx())

    expect(result.metadata.error).toBe("Engine crashed")
  })
})
