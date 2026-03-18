/**
 * Run SQL against local DuckDB — validate syntax, types, and logic locally.
 *
 * Ported from Python altimate_engine.local.test_local.
 */

import * as core from "@altimateai/altimate-core"
import type {
  LocalTestParams,
  LocalTestResult,
} from "../types"

/**
 * Execute SQL against a local DuckDB database for validation.
 *
 * If target_dialect differs from DuckDB, auto-transpiles first using altimate-core.
 */
export async function testSqlLocal(params: LocalTestParams): Promise<LocalTestResult> {
  const targetPath = params.target_path || ":memory:"

  // Auto-transpile if target dialect differs from DuckDB
  let testSql = params.sql
  let transpiled = false
  const transpileWarnings: string[] = []

  if (params.target_dialect && !["duckdb", "duck"].includes(params.target_dialect.toLowerCase())) {
    try {
      const result = core.transpile(params.sql, params.target_dialect, "duckdb")
      const data = JSON.parse(JSON.stringify(result))
      const translated = data.sql || data.translated_sql
      if (translated) {
        testSql = translated
        transpiled = true
        if (data.warnings) {
          transpileWarnings.push(...data.warnings)
        }
      }
    } catch (e) {
      transpileWarnings.push(`Transpilation failed, testing original SQL: ${e}`)
    }
  }

  // Dynamic import of DuckDB driver
  let localConnector: any
  try {
    const duckdbDriver = await import("@altimateai/drivers/duckdb")
    localConnector = await duckdbDriver.connect({ type: "duckdb", path: targetPath })
    await localConnector.connect()
  } catch {
    return {
      success: false,
      row_count: 0,
      columns: [],
      sample_rows: [],
      transpiled,
      transpile_warnings: transpileWarnings.length > 0 ? transpileWarnings : undefined,
      error: "DuckDB driver not available. Ensure duckdb is installed.",
    }
  }

  try {
    const result = await localConnector.execute(testSql, 100)

    // Convert rows to Record<string, unknown>[]
    const sampleRows: Record<string, unknown>[] = result.rows.slice(0, 5).map((row: any[]) => {
      const obj: Record<string, unknown> = {}
      result.columns.forEach((col: string, i: number) => {
        obj[col] = row[i]
      })
      return obj
    })

    return {
      success: true,
      row_count: result.row_count,
      columns: result.columns,
      sample_rows: sampleRows,
      transpiled,
      transpile_warnings: transpileWarnings.length > 0 ? transpileWarnings : undefined,
    }
  } catch (e) {
    return {
      success: false,
      row_count: 0,
      columns: [],
      sample_rows: [],
      transpiled,
      transpile_warnings: transpileWarnings.length > 0 ? transpileWarnings : undefined,
      error: String(e),
    }
  } finally {
    try { await localConnector.close() } catch { /* ignore */ }
  }
}
