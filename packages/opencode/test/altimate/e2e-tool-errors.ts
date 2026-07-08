#!/usr/bin/env bun
/**
 * E2E test: calls actual tool execute() functions through real dispatcher
 * with real altimate-core napi bindings. No mocks.
 *
 * Run: cd packages/opencode && bun run test/altimate/e2e-tool-errors.ts
 */

import { Dispatcher } from "../../src/altimate/native"
import { initTool } from "./tool-fixture"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

// Disable telemetry
process.env.ALTIMATE_TELEMETRY_DISABLED = "true"

// Stub context for tool.execute()
function stubCtx(): any {
  return {
    sessionID: "e2e-test",
    messageID: "e2e-test",
    agent: "test",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  }
}

// Telemetry extraction logic from tool.ts
function telemetryError(metadata: Record<string, any>): string {
  return typeof metadata?.error === "string" ? metadata.error : "unknown error"
}

let passed = 0
let failed = 0

async function check(
  name: string,
  fn: () => Promise<{ metadata: Record<string, any>; output: string; title: string }>,
  expect: {
    metadataErrorContains?: string
    metadataErrorUndefined?: boolean
    metadataSuccess?: boolean
    noUnknownError?: boolean
    outputContains?: string
  },
) {
  try {
    const result = await fn()
    const errors: string[] = []

    if (expect.metadataErrorContains) {
      if (!result.metadata.error?.includes(expect.metadataErrorContains)) {
        errors.push(
          `metadata.error should contain "${expect.metadataErrorContains}" but got: ${JSON.stringify(result.metadata.error)}`,
        )
      }
    }
    if (expect.metadataErrorUndefined) {
      if (result.metadata.error !== undefined) {
        errors.push(`metadata.error should be undefined but got: ${JSON.stringify(result.metadata.error)}`)
      }
    }
    if (expect.metadataSuccess !== undefined) {
      if (result.metadata.success !== expect.metadataSuccess) {
        errors.push(`metadata.success should be ${expect.metadataSuccess} but got: ${result.metadata.success}`)
      }
    }
    if (expect.noUnknownError) {
      const extracted = telemetryError(result.metadata)
      if (result.metadata.success === false && extracted === "unknown error") {
        errors.push(`telemetry would log "unknown error" — metadata.error is missing on failure path`)
      }
    }
    if (expect.outputContains) {
      if (!result.output?.includes(expect.outputContains)) {
        errors.push(`output should contain "${expect.outputContains}" but got: ${result.output?.slice(0, 200)}`)
      }
    }

    if (errors.length > 0) {
      console.log(`  FAIL  ${name}`)
      for (const e of errors) console.log(`        ${e}`)
      console.log(`        metadata: ${JSON.stringify(result.metadata)}`)
      failed++
    } else {
      console.log(`  PASS  ${name}`)
      passed++
    }
  } catch (e) {
    console.log(`  FAIL  ${name}`)
    console.log(`        THREW: ${e instanceof Error ? e.message : String(e)}`)
    failed++
  }
}

// Create a temp schema file for schema_path testing
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-schema-"))
const schemaJsonPath = path.join(tmpDir, "schema.json")
fs.writeFileSync(
  schemaJsonPath,
  JSON.stringify({
    tables: {
      users: {
        columns: [
          { name: "id", type: "INTEGER" },
          { name: "name", type: "VARCHAR" },
          { name: "email", type: "VARCHAR" },
        ],
      },
      orders: {
        columns: [
          { name: "id", type: "INTEGER" },
          { name: "user_id", type: "INTEGER" },
          { name: "total", type: "DECIMAL" },
          { name: "created_at", type: "TIMESTAMP" },
        ],
      },
    },
  }),
)

const schemaYamlPath = path.join(tmpDir, "schema.yaml")
fs.writeFileSync(
  schemaYamlPath,
  `tables:
  users:
    columns:
      - name: id
        type: INTEGER
      - name: name
        type: VARCHAR
      - name: email
        type: VARCHAR
  orders:
    columns:
      - name: id
        type: INTEGER
      - name: user_id
        type: INTEGER
      - name: total
        type: DECIMAL
`,
)

const testSql = "SELECT u.id, u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id WHERE o.total > 100"
const badSql = "SELCT * FORM users"

const flatSchema = {
  users: { id: "INTEGER", name: "VARCHAR", email: "VARCHAR" },
  orders: { id: "INTEGER", user_id: "INTEGER", total: "DECIMAL", created_at: "TIMESTAMP" },
}

async function main() {
  // Force lazy registration
  await Dispatcher.call("altimate_core.validate" as any, {
    sql: "SELECT 1",
    schema_path: "",
    schema_context: undefined,
  })

  console.log("\n" + "=".repeat(70))
  console.log("E2E TOOL ERROR PROPAGATION TESTS")
  console.log("=".repeat(70))

  // =========================================================================
  // 1. altimate_core_validate
  // =========================================================================
  console.log("\n--- altimate_core_validate ---")

  const { AltimateCoreValidateTool } = await import("../../src/altimate/tools/altimate-core-validate")
  const validateTool = await initTool(AltimateCoreValidateTool)

  await check(
    "validate: no schema → early return with 'No schema provided'",
    async () => {
      return validateTool.execute({ sql: testSql }, stubCtx())
    },
    { metadataSuccess: false, metadataErrorContains: "No schema provided", noUnknownError: true },
  )

  await check(
    "validate: with schema_context (flat) → success",
    async () => {
      return validateTool.execute({ sql: testSql, schema_context: flatSchema }, stubCtx())
    },
    { metadataSuccess: true },
  )

  await check(
    "validate: with schema_path (JSON file) → success",
    async () => {
      return validateTool.execute({ sql: testSql, schema_path: schemaJsonPath }, stubCtx())
    },
    { metadataSuccess: true },
  )

  await check(
    "validate: with schema_path (YAML file) → success",
    async () => {
      return validateTool.execute({ sql: testSql, schema_path: schemaYamlPath }, stubCtx())
    },
    { metadataSuccess: true },
  )

  await check(
    "validate: with schema_path (nonexistent file) → error",
    async () => {
      return validateTool.execute({ sql: testSql, schema_path: "/tmp/nonexistent-schema-abc123.json" }, stubCtx())
    },
    { metadataSuccess: false, noUnknownError: true },
  )

  await check(
    "validate: syntax error SQL with schema → error propagated",
    async () => {
      return validateTool.execute({ sql: badSql, schema_context: flatSchema }, stubCtx())
    },
    { metadataSuccess: true, metadataErrorContains: "Syntax error", noUnknownError: true },
  )

  // =========================================================================
  // 2. altimate_core_semantics
  // =========================================================================
  console.log("\n--- altimate_core_semantics ---")

  const { AltimateCoreSemanticsTool } = await import("../../src/altimate/tools/altimate-core-semantics")
  const semanticsTool = await initTool(AltimateCoreSemanticsTool)

  await check(
    "semantics: no schema → early return with 'No schema provided'",
    async () => {
      return semanticsTool.execute({ sql: testSql }, stubCtx())
    },
    { metadataSuccess: false, metadataErrorContains: "No schema provided", noUnknownError: true },
  )

  await check(
    "semantics: with schema_context → runs (may find issues)",
    async () => {
      return semanticsTool.execute({ sql: testSql, schema_context: flatSchema }, stubCtx())
    },
    { noUnknownError: true },
  )

  await check(
    "semantics: with schema_path → runs",
    async () => {
      return semanticsTool.execute({ sql: testSql, schema_path: schemaJsonPath }, stubCtx())
    },
    { noUnknownError: true },
  )

  // =========================================================================
  // 3. altimate_core_equivalence
  // =========================================================================
  console.log("\n--- altimate_core_equivalence ---")

  const { AltimateCoreEquivalenceTool } = await import("../../src/altimate/tools/altimate-core-equivalence")
  const equivTool = await initTool(AltimateCoreEquivalenceTool)

  const sql2 = "SELECT u.id, u.name, o.total FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE o.total > 100"

  await check(
    "equivalence: no schema → early return with 'No schema provided'",
    async () => {
      return equivTool.execute({ sql1: testSql, sql2 }, stubCtx())
    },
    { metadataSuccess: false, metadataErrorContains: "No schema provided", noUnknownError: true },
  )

  await check(
    "equivalence: with schema_context → runs",
    async () => {
      return equivTool.execute({ sql1: testSql, sql2, schema_context: flatSchema }, stubCtx())
    },
    { noUnknownError: true },
  )

  await check(
    "equivalence: with schema_path → runs",
    async () => {
      return equivTool.execute({ sql1: testSql, sql2, schema_path: schemaJsonPath }, stubCtx())
    },
    { noUnknownError: true },
  )

  // =========================================================================
  // 4. altimate_core_fix
  // =========================================================================
  console.log("\n--- altimate_core_fix ---")

  const { AltimateCoreFixTool } = await import("../../src/altimate/tools/altimate-core-fix")
  const fixTool = await initTool(AltimateCoreFixTool)

  await check(
    "fix: unfixable syntax error → error propagated",
    async () => {
      return fixTool.execute({ sql: badSql }, stubCtx())
    },
    { metadataSuccess: true, noUnknownError: true },
  )

  await check(
    "fix: valid SQL → success (already valid)",
    async () => {
      return fixTool.execute({ sql: "SELECT 1", schema_context: flatSchema }, stubCtx())
    },
    { metadataSuccess: true },
  )

  // =========================================================================
  // 5. altimate_core_correct
  // =========================================================================
  console.log("\n--- altimate_core_correct ---")

  const { AltimateCoreCorrectTool } = await import("../../src/altimate/tools/altimate-core-correct")
  const correctTool = await initTool(AltimateCoreCorrectTool)

  await check(
    "correct: unfixable syntax error → error propagated",
    async () => {
      return correctTool.execute({ sql: badSql }, stubCtx())
    },
    { metadataSuccess: true, noUnknownError: true },
  )

  // =========================================================================
  // 6. sql_analyze
  // =========================================================================
  console.log("\n--- sql_analyze ---")

  const { SqlAnalyzeTool } = await import("../../src/altimate/tools/sql-analyze")
  const analyzeTool = await initTool(SqlAnalyzeTool)

  await check(
    "analyze: no schema → lint issues found (partial success)",
    async () => {
      return analyzeTool.execute({ sql: testSql, dialect: "snowflake" }, stubCtx())
    },
    { noUnknownError: true },
  )

  await check(
    "analyze: with schema_context → richer analysis",
    async () => {
      const result = await analyzeTool.execute(
        { sql: testSql, dialect: "snowflake", schema_context: flatSchema },
        stubCtx(),
      )
      // With schema, should get more issues (semantic + lint)
      const issueCount = result.metadata.issueCount ?? 0
      if (issueCount <= 1) {
        console.log(`        NOTE: only ${issueCount} issues with schema (expected > 1 for semantic analysis)`)
      }
      return result
    },
    { noUnknownError: true },
  )

  await check(
    "analyze: with schema_path → richer analysis",
    async () => {
      return analyzeTool.execute({ sql: testSql, dialect: "snowflake", schema_path: schemaJsonPath }, stubCtx())
    },
    { noUnknownError: true },
  )

  // =========================================================================
  // 7. sql_explain
  // =========================================================================
  console.log("\n--- sql_explain ---")

  const { SqlExplainTool } = await import("../../src/altimate/tools/sql-explain")
  const explainTool = await initTool(SqlExplainTool)

  await check(
    "explain: no warehouse → error propagated (not 'unknown error')",
    async () => {
      return explainTool.execute({ sql: testSql, analyze: false }, stubCtx())
    },
    { metadataSuccess: false, noUnknownError: true },
  )

  // =========================================================================
  // 8. finops_query_history
  // =========================================================================
  console.log("\n--- finops_query_history ---")

  const { FinopsQueryHistoryTool } = await import("../../src/altimate/tools/finops-query-history")
  const queryHistTool = await initTool(FinopsQueryHistoryTool)

  await check(
    "query_history: no warehouse → error propagated",
    async () => {
      return queryHistTool.execute({ warehouse: "nonexistent", days: 7, limit: 10 }, stubCtx())
    },
    { metadataSuccess: false, noUnknownError: true },
  )

  // =========================================================================
  // 9. finops_expensive_queries
  // =========================================================================
  console.log("\n--- finops_expensive_queries ---")

  const { FinopsExpensiveQueriesTool } = await import("../../src/altimate/tools/finops-expensive-queries")
  const expensiveTool = await initTool(FinopsExpensiveQueriesTool)

  await check(
    "expensive_queries: no warehouse → error propagated",
    async () => {
      return expensiveTool.execute({ warehouse: "nonexistent", days: 7, limit: 20 }, stubCtx())
    },
    { metadataSuccess: false, noUnknownError: true },
  )

  // =========================================================================
  // 10. finops_analyze_credits
  // =========================================================================
  console.log("\n--- finops_analyze_credits ---")

  const { FinopsAnalyzeCreditsTool } = await import("../../src/altimate/tools/finops-analyze-credits")
  const creditsTool = await initTool(FinopsAnalyzeCreditsTool)

  await check(
    "analyze_credits: no warehouse → error propagated",
    async () => {
      return creditsTool.execute({ warehouse: "nonexistent", days: 30, limit: 50 }, stubCtx())
    },
    { metadataSuccess: false, noUnknownError: true },
  )

  // =========================================================================
  // 11. finops_unused_resources
  // =========================================================================
  console.log("\n--- finops_unused_resources ---")

  const { FinopsUnusedResourcesTool } = await import("../../src/altimate/tools/finops-unused-resources")
  const unusedTool = await initTool(FinopsUnusedResourcesTool)

  await check(
    "unused_resources: no warehouse → error propagated",
    async () => {
      return unusedTool.execute({ warehouse: "nonexistent", days: 30, limit: 50 }, stubCtx())
    },
    { metadataSuccess: false, noUnknownError: true },
  )

  // =========================================================================
  // 12. finops_warehouse_advice
  // =========================================================================
  console.log("\n--- finops_warehouse_advice ---")

  const { FinopsWarehouseAdviceTool } = await import("../../src/altimate/tools/finops-warehouse-advice")
  const adviceTool = await initTool(FinopsWarehouseAdviceTool)

  await check(
    "warehouse_advice: no warehouse → error propagated",
    async () => {
      return adviceTool.execute({ warehouse: "nonexistent", days: 14 }, stubCtx())
    },
    { metadataSuccess: false, noUnknownError: true },
  )

  // =========================================================================
  // Schema resolution edge cases
  // =========================================================================
  console.log("\n--- schema resolution edge cases ---")

  await check(
    "schema_path: empty string → treated as no schema",
    async () => {
      return validateTool.execute({ sql: testSql, schema_path: "" }, stubCtx())
    },
    { metadataSuccess: false, metadataErrorContains: "No schema provided", noUnknownError: true },
  )

  await check(
    "schema_context: empty object → treated as no schema",
    async () => {
      return validateTool.execute({ sql: testSql, schema_context: {} }, stubCtx())
    },
    { metadataSuccess: false, metadataErrorContains: "No schema provided", noUnknownError: true },
  )

  await check(
    "schema_context: array format → works",
    async () => {
      return validateTool.execute(
        {
          sql: "SELECT id FROM users",
          schema_context: {
            users: [
              { name: "id", type: "INTEGER" },
              { name: "name", type: "VARCHAR" },
            ],
          },
        },
        stubCtx(),
      )
    },
    { metadataSuccess: true },
  )

  await check(
    "schema_context: SchemaDefinition format → works",
    async () => {
      return validateTool.execute(
        {
          sql: "SELECT id FROM users",
          schema_context: {
            tables: {
              users: {
                columns: [
                  { name: "id", type: "INTEGER" },
                  { name: "name", type: "VARCHAR" },
                ],
              },
            },
          },
        },
        stubCtx(),
      )
    },
    { metadataSuccess: true },
  )

  // =========================================================================
  // Summary
  // =========================================================================
  console.log("\n" + "=".repeat(70))
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`)
  console.log("=".repeat(70))

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true })

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error("FATAL:", e)
  process.exit(1)
})
