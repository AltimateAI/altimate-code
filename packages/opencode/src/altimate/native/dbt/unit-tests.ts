/**
 * dbt unit test generator.
 *
 * Pipeline:
 *   1. Parse manifest (reuses helpers) → model, deps, columns, descriptions
 *   2. Column lineage (reuses dbtLineage) → input→output mapping
 *   3. Keyword-based scenario detection → which test categories to generate
 *   4. Type-correct mock data → placeholder rows for the LLM to refine
 *   5. YAML assembly (via `yaml` library) → ready to paste into schema.yml
 *
 * The tool generates scaffold tests with type-correct placeholder values.
 * The LLM skill layer refines values by reading the compiled SQL, column
 * descriptions, and lineage to craft rows that target specific logic branches.
 */

import YAML from "yaml"
import { call as dispatcherCall } from "../dispatcher"
import type {
  DbtUnitTestGenParams,
  DbtUnitTestGenResult,
  DbtModelInfo,
  DbtSourceInfo,
  ModelColumn,
  UnitTestCase,
  UnitTestContext,
  UnitTestMockInput,
} from "../types"
import { parseManifest } from "./manifest"
import { dbtLineage } from "./lineage"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SCENARIOS = 3

/** Sample values by broad data type category. */
const MOCK_VALUES: Record<string, unknown[]> = {
  integer: [1, 2, 3, 0, -1],
  float: [10.5, 25.0, 0.0, -5.5, 100.99],
  string: ["alpha", "beta", "gamma", "", "test_value"],
  boolean: [true, false, true],
  date: ["2024-01-15", "2024-06-30", "2023-12-31"],
  timestamp: ["2024-01-15 10:30:00", "2024-06-30 23:59:59", "2023-12-31 00:00:00"],
  numeric: [100.00, 50.00, 0.00, -25.00, 999.99],
}

/**
 * Map SQL type names (across dialects) to mock value categories.
 * Covers Snowflake, BigQuery, Postgres, Redshift, Databricks, DuckDB, MySQL.
 */
const TYPE_MAP: Record<string, string> = {
  int: "integer", integer: "integer", bigint: "integer", smallint: "integer",
  tinyint: "integer", int64: "integer", int32: "integer",
  number: "numeric", numeric: "numeric", decimal: "numeric",
  float: "float", double: "float", float64: "float", real: "float",
  varchar: "string", string: "string", text: "string", char: "string",
  character: "string", "character varying": "string",
  boolean: "boolean", bool: "boolean",
  date: "date",
  timestamp: "timestamp", timestamp_ntz: "timestamp", timestamp_ltz: "timestamp",
  timestamp_tz: "timestamp", datetime: "timestamp",
}

// ---------------------------------------------------------------------------
// Upstream dependency resolution (from parseManifest output, no raw manifest)
// ---------------------------------------------------------------------------

interface UpstreamDep {
  unique_id: string
  name: string
  source_name?: string
  schema_name?: string
  database?: string
  description?: string
  resource_type: "model" | "source" | "seed" | "snapshot"
  materialized?: string
  columns: ModelColumn[]
}

function resolveUpstream(
  upstreamIds: string[],
  models: DbtModelInfo[],
  sources: DbtSourceInfo[],
  seeds: DbtModelInfo[],
  snapshots: DbtModelInfo[],
): UpstreamDep[] {
  // Map each unique_id to its info + resource_type.
  // Seeds, snapshots, and models all use ref() so they share handling.
  const typedMap = new Map<string, { info: DbtModelInfo; kind: "model" | "seed" | "snapshot" }>()
  for (const m of models) typedMap.set(m.unique_id, { info: m, kind: "model" })
  for (const s of seeds) typedMap.set(s.unique_id, { info: s, kind: "seed" })
  for (const s of snapshots) typedMap.set(s.unique_id, { info: s, kind: "snapshot" })
  const sourceMap = new Map(sources.map((s) => [s.unique_id, s]))

  const result: UpstreamDep[] = []
  for (const uid of upstreamIds) {
    const entry = typedMap.get(uid)
    if (entry) {
      result.push({
        unique_id: uid,
        name: entry.info.name,
        schema_name: entry.info.schema_name,
        database: entry.info.database,
        description: entry.info.description,
        resource_type: entry.kind,
        materialized: entry.info.materialized,
        columns: entry.info.columns,
      })
      continue
    }
    const source = sourceMap.get(uid)
    if (source) {
      result.push({
        unique_id: uid,
        name: source.name,
        source_name: source.source_name,
        schema_name: source.schema_name,
        database: source.database,
        description: source.description,
        resource_type: "source",
        columns: source.columns,
      })
    }
  }
  return result
}

function depRef(dep: UpstreamDep): string {
  // Models, seeds, and snapshots all use ref(); only sources use source()
  return dep.resource_type === "source"
    ? `source('${dep.source_name}', '${dep.name}')`
    : `ref('${dep.name}')`
}

// ---------------------------------------------------------------------------
// Column enrichment (warehouse fallback when manifest has no columns)
// ---------------------------------------------------------------------------

/**
 * Enrich deps that have no manifest columns by querying the warehouse.
 * Uses schema.inspect (dialect-agnostic, no dbt subprocess needed).
 * Runs in parallel across all deps. All calls are best-effort.
 *
 * If both manifest and schema.inspect return nothing, the generated test
 * will have placeholder rows. The skill layer can then call
 * `altimate-dbt columns --model <name>` via bash to discover columns
 * through dbt's own adapter (which handles venv/pyenv/conda resolution).
 */
async function enrichColumns(deps: UpstreamDep[]): Promise<void> {
  await Promise.all(
    deps.map(async (dep) => {
      if (dep.materialized === "ephemeral" || dep.columns.length > 0) return

      const tableName = dep.name
      if (!tableName) return

      try {
        const r = await dispatcherCall("schema.inspect", {
          table: tableName,
          schema_name: dep.schema_name,
          ...(dep.database && { database: dep.database }),
        })
        if (r.columns?.length) {
          dep.columns = r.columns.map((c) => ({
            name: c.name, data_type: c.data_type, description: undefined,
          }))
        }
      } catch { /* warehouse unavailable — will use placeholder rows */ }
    }),
  )
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateDbtUnitTests(
  params: DbtUnitTestGenParams,
): Promise<DbtUnitTestGenResult> {
  const warnings: string[] = []
  const antiPatterns: string[] = []
  const maxScenarios = params.max_scenarios ?? DEFAULT_MAX_SCENARIOS

  // 1. Parse manifest via existing parseManifest() — no raw manifest reading
  const manifest = await parseManifest({ path: params.manifest_path })
  if (manifest.model_count === 0 && manifest.source_count === 0) {
    return failResult(params.model, "Manifest file not found or invalid. Run `dbt compile` first.")
  }

  // 2. Find model in parsed manifest
  const model = manifest.models.find(
    (m) => m.name === params.model || m.unique_id === params.model,
  )
  if (!model) {
    return failResult(params.model, `Model '${params.model}' not found in manifest. Available models: ${manifest.models.slice(0, 10).map((m) => m.name).join(", ")}`)
  }

  // 3. Get compiled SQL + lineage via existing dbtLineage() (reads manifest once, cached)
  const dialect = params.dialect || manifest.adapter_type || undefined
  const lineageResult = dbtLineage({ manifest_path: params.manifest_path, model: params.model, dialect })
  const compiledSql = lineageResult.compiled_sql || ""
  if (!compiledSql) {
    return failResult(model.name, "No compiled SQL found. Run `dbt compile` first, then retry.")
  }

  // 4. Extract lineage map from lineage result
  let lineageMap: Record<string, string[]> = {}
  if (lineageResult.confidence !== "low") {
    lineageMap = extractLineageMap(lineageResult.raw_lineage)
  } else {
    warnings.push("Column lineage analysis failed — generating tests without lineage context")
  }

  // 5. Resolve upstream deps (models, sources, seeds, snapshots)
  const upstreamDeps = resolveUpstream(
    model.depends_on, manifest.models, manifest.sources, manifest.seeds, manifest.snapshots,
  )
  // Warn if any deps couldn't be resolved (e.g., unknown resource types like
  // semantic_model.*, or deps missing from the manifest). This prevents the
  // generated YAML from silently missing required `given` inputs.
  const resolvedIds = new Set(upstreamDeps.map((d) => d.unique_id))
  const unresolved = model.depends_on.filter((id) => !resolvedIds.has(id))
  if (unresolved.length > 0) {
    warnings.push(
      `Could not resolve ${unresolved.length} upstream dep(s) — generated YAML may be missing mock inputs: ${unresolved.join(", ")}`,
    )
  }
  const materialized = model.materialized || "view"

  // 6. Enrich columns from warehouse (parallel, best-effort)
  await enrichColumns(upstreamDeps)

  // 7. Anti-patterns via existing sql.optimize
  try {
    // Build schema context from upstream dep columns
    const schemaContext = buildSchemaContextFromDeps(upstreamDeps)
    const r = await dispatcherCall("sql.optimize", { sql: compiledSql, dialect, schema_context: schemaContext ?? undefined })
    for (const ap of r.anti_patterns || []) { if (ap.message) antiPatterns.push(ap.message) }
  } catch { /* non-critical */ }

  // 8. Detect scenarios from SQL keywords
  const scenarios = detectScenarios(compiledSql, materialized)

  // 9. Ephemeral deps
  const ephemeralDeps = new Set<string>()
  for (const dep of upstreamDeps) {
    if (dep.materialized === "ephemeral") {
      ephemeralDeps.add(dep.unique_id)
      warnings.push(`Upstream '${dep.name}' is ephemeral — using sql format for its mock input`)
    }
  }

  // 10. Output columns (manifest → warehouse fallback)
  let outputColumns = model.columns
  if (outputColumns.length === 0) {
    try {
      const r = await dispatcherCall("schema.inspect", { table: model.name, schema_name: model.schema_name, ...(model.database && { database: model.database }) })
      if (r.columns?.length) outputColumns = r.columns.map((c: any) => ({ name: c.name, data_type: c.data_type, description: undefined }))
    } catch { /* model may not be materialized yet */ }
  }

  // 11. Generate test cases
  const tests = buildTests(model.name, upstreamDeps, scenarios, outputColumns, ephemeralDeps, maxScenarios)

  // 12. YAML
  const yaml = assembleYaml(model.name, tests)

  // 13. Semantic context for LLM refinement
  const context: UnitTestContext = {
    model_description: model.description,
    compiled_sql: compiledSql,
    column_lineage: lineageMap,
    upstream: upstreamDeps.map((d) => ({
      name: d.name, ref: depRef(d), description: d.description, columns: d.columns,
    })),
    output_columns: outputColumns,
  }

  return {
    success: true,
    model_name: model.name,
    model_unique_id: model.unique_id,
    materialized,
    dependency_count: model.depends_on.length,
    tests,
    yaml,
    context,
    anti_patterns: antiPatterns,
    warnings,
  }
}

/** Build schema context from resolved upstream deps (for sql.optimize). */
function buildSchemaContextFromDeps(deps: UpstreamDep[]): Record<string, any> | null {
  const tables: Record<string, any> = {}
  for (const dep of deps) {
    if (dep.columns.length === 0) continue
    tables[dep.name] = {
      columns: dep.columns.map((c) => ({ name: c.name, type: c.data_type || "" })),
    }
  }
  if (Object.keys(tables).length === 0) return null
  return { tables, version: "1" }
}

// ---------------------------------------------------------------------------
// Lineage extraction
// ---------------------------------------------------------------------------

function extractLineageMap(rawLineage: Record<string, unknown>): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  try {
    const dict = (rawLineage.column_dict || rawLineage.columns || {}) as Record<string, any>
    for (const [col, srcList] of Object.entries(dict)) {
      if (Array.isArray(srcList)) {
        map[col] = srcList.map((s: any) =>
          `${s.source_table || s.table || "?"}.${s.source_column || s.column || "?"}`,
        )
      }
    }
  } catch { /* ignore */ }
  return map
}

// ---------------------------------------------------------------------------
// Scenario detection (simple keyword checks — LLM reads SQL for details)
// ---------------------------------------------------------------------------

interface Scenario {
  category: string
  description: string
  mockStyle: "happy_path" | "null_edge" | "boundary"
  rowCount: number
}

/**
 * Detect which test scenarios to generate based on SQL keyword presence.
 * Intentionally simple — the LLM skill layer reads the compiled SQL
 * directly for nuanced logic analysis. This just determines the scaffold.
 */
function detectScenarios(sql: string, materialized: string): Scenario[] {
  // Strip SQL comments AND string literals to avoid false positives
  // (e.g., "-- old/code", "'2024/01/15'", "'a/b'" matching division).
  const cleaned = sql
    .replace(/--.*$/gm, "")                  // line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")        // block comments
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")  // single-quoted strings
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')  // double-quoted identifiers/strings
  const upper = cleaned.toUpperCase()
  const scenarios: Scenario[] = [
    { category: "happy_path", description: "Verify correct output for standard input data", mockStyle: "happy_path", rowCount: 2 },
  ]

  if (/\bCASE\b/.test(upper) || /\bCOALESCE\b/.test(upper) || /\bNVL\b/.test(upper) || /\bIFNULL\b/.test(upper)) {
    scenarios.push({ category: "null_handling", description: "Verify NULL/conditional handling", mockStyle: "null_edge", rowCount: 2 })
  }
  if (/\bJOIN\b/.test(upper)) {
    scenarios.push({ category: "edge_case", description: "Verify JOIN behavior with non-matching rows", mockStyle: "boundary", rowCount: 2 })
  }
  if (/\bGROUP\s+BY\b/.test(upper) || /\bOVER\s*\(/.test(upper)) {
    scenarios.push({ category: "edge_case", description: "Verify aggregation/window with multiple rows", mockStyle: "happy_path", rowCount: 3 })
  }
  // Division detection — match `/` between two "operand-like" tokens.
  // An operand is: identifier, dotted identifier (a.b), function call like
  // SUM(...), CAST(... AS ...), COALESCE(...), NULLIF(...), or parenthesized
  // expression. String literals are already stripped above.
  // We deliberately exclude `/*` (block comment open, already stripped) and
  // `//` (some dialects use it but not in compiled dbt SQL).
  const operand = /(?:\w+\s*\([^)]*\)|\w+(?:\.\w+)?|\([^)]*\))/.source
  const divisionRegex = new RegExp(`${operand}\\s*\\/(?!\\*|\\/)\\s*${operand}`)
  if (divisionRegex.test(cleaned)) {
    scenarios.push({ category: "edge_case", description: "Verify divide-by-zero protection", mockStyle: "boundary", rowCount: 2 })
  }
  if (materialized === "incremental") {
    scenarios.push({ category: "incremental", description: "Verify incremental logic processes only new rows", mockStyle: "happy_path", rowCount: 2 })
  }

  return scenarios
}

// ---------------------------------------------------------------------------
// Mock data generation
// ---------------------------------------------------------------------------

function mockValueForType(dataType: string, rowIndex: number): unknown {
  const normalized = (dataType || "string").toLowerCase().replace(/\(.*\)/, "").trim()
  const values = MOCK_VALUES[TYPE_MAP[normalized] || "string"] || MOCK_VALUES.string!
  return values[rowIndex % values.length]
}

function isKeyColumn(name: string): boolean {
  const l = name.toLowerCase()
  return l.endsWith("_id") || l === "id" || l.endsWith("_key") || l === "key"
}

function boundaryValue(dataType: string): unknown {
  const cat = TYPE_MAP[(dataType || "string").toLowerCase().replace(/\(.*\)/, "").trim()] || "string"
  const map: Record<string, unknown> = {
    integer: 0, float: 0.0, numeric: 0.0, string: "", boolean: false,
    date: "1970-01-01", timestamp: "1970-01-01 00:00:00",
  }
  return map[cat] ?? null
}

function generateRows(
  columns: ModelColumn[],
  rowCount: number,
  style: "happy_path" | "null_edge" | "boundary" | "empty",
): Record<string, unknown>[] {
  if (style === "empty") return []
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < rowCount; i++) {
    const row: Record<string, unknown> = {}
    for (const col of columns) {
      if (style === "null_edge" && i === rowCount - 1 && !isKeyColumn(col.name)) {
        row[col.name] = null
      } else if (style === "boundary" && i === rowCount - 1) {
        row[col.name] = boundaryValue(col.data_type)
      } else {
        row[col.name] = mockValueForType(col.data_type, i)
      }
    }
    rows.push(row)
  }
  return rows
}

// ---------------------------------------------------------------------------
// Test case generation
// ---------------------------------------------------------------------------

function buildTests(
  modelName: string,
  deps: UpstreamDep[],
  scenarios: Scenario[],
  outputColumns: ModelColumn[],
  ephemeralDeps: Set<string>,
  maxScenarios: number,
): UnitTestCase[] {
  // Preserve the incremental scenario even when truncating to maxScenarios.
  // Otherwise SQL with enough non-incremental triggers (JOIN + CASE + division)
  // would push the incremental test out of the capped window, losing the
  // `input: this` mock entirely for incremental models.
  const capped = scenarios.slice(0, maxScenarios)
  const incremental = scenarios.find((s) => s.category === "incremental")
  if (incremental && !capped.includes(incremental)) {
    // Replace the last non-happy-path scenario with the incremental one.
    // Happy path is always first and must be kept.
    capped[capped.length - 1] = incremental
  }

  return capped.map((scenario, idx) => {
    // Build the scenario suffix first, then truncate the model-name portion
    // so the suffix is always preserved (prevents collisions for long names).
    const suffix = `_${scenario.category}${idx > 0 ? `_${idx}` : ""}`
    const prefix = "test_"
    const maxLen = 64
    const modelBudget = maxLen - prefix.length - suffix.length
    const truncatedModel = modelName.length > modelBudget ? modelName.slice(0, Math.max(1, modelBudget)) : modelName
    const testName = sanitizeName(`${prefix}${truncatedModel}${suffix}`)

    const given: UnitTestMockInput[] = deps.map((dep) => {
      const input = depRef(dep)
      const isEphemeral = ephemeralDeps.has(dep.unique_id)

      if (dep.columns.length === 0) {
        // Ephemeral models MUST use format: sql — dict format crashes dbt test
        if (isEphemeral) {
          return {
            input, rows: [], format: "sql" as const,
            sql: "SELECT 1 AS _placeholder -- REPLACE_WITH_ACTUAL_COLUMNS",
          }
        }
        return { input, rows: [{ _placeholder: "REPLACE_WITH_ACTUAL_COLUMNS" }] }
      }

      const rows = generateRows(dep.columns, scenario.rowCount, scenario.mockStyle)

      if (isEphemeral) {
        return {
          input,
          rows: [],
          format: "sql" as const,
          sql: rows.map((row) =>
            `SELECT ${Object.entries(row).map(([k, v]) => `${formatSqlLiteral(v)} AS ${quoteIdent(k)}`).join(", ")}`,
          ).join("\nUNION ALL\n"),
        }
      }
      return { input, rows }
    })

    const expect_rows = outputColumns.length > 0
      ? generateRows(outputColumns, scenario.rowCount, scenario.mockStyle)
      : [{ _note: "REPLACE — run `dbt test` to compute expected output" }]

    const test: UnitTestCase = {
      name: testName,
      description: scenario.description,
      category: scenario.category,
      target_logic: scenario.description,
      given,
      expect_rows,
    }

    if (scenario.category === "incremental") {
      test.overrides = { macros: { is_incremental: true } }
      // dbt's incremental path references {{ this }} — must mock the existing target table
      test.given.push({
        input: "this",
        rows: outputColumns.length > 0
          ? generateRows(outputColumns, 1, "happy_path")
          : [{ _placeholder: "REPLACE_WITH_EXISTING_TABLE_STATE" }],
      })
    }

    return test
  })
}

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 64)
}

function formatSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  return String(value)
}

/**
 * Quote a column identifier with double quotes (ANSI SQL / dbt standard).
 * Handles reserved keywords (`select`, `order`, `group`), mixed case, and
 * names with special characters. Escapes embedded double quotes.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

// ---------------------------------------------------------------------------
// YAML assembly (uses `yaml` library — no hand-built string concatenation)
// ---------------------------------------------------------------------------

export function assembleYaml(modelName: string, tests: UnitTestCase[]): string {
  const doc = {
    unit_tests: tests.map((test) => {
      const entry: Record<string, any> = {
        name: test.name,
        description: test.description,
        model: modelName,
      }

      if (test.overrides) entry.overrides = test.overrides

      entry.given = test.given.map((input) => {
        if (input.format === "sql" && input.sql) {
          return { input: input.input, format: "sql", rows: input.sql }
        }
        return { input: input.input, rows: input.rows }
      })

      entry.expect = { rows: test.expect_rows }
      return entry
    }),
  }

  return YAML.stringify(doc, { lineWidth: 0 })
}

// ---------------------------------------------------------------------------
// Failure helper
// ---------------------------------------------------------------------------

function failResult(modelName: string, error: string): DbtUnitTestGenResult {
  return {
    success: false, model_name: modelName, materialized: undefined,
    dependency_count: 0, tests: [], yaml: "", anti_patterns: [], warnings: [], error,
  }
}
