/**
 * Register composite SQL dispatcher methods that combine
 * altimate-core analysis calls with result formatting.
 *
 * These 10 methods were previously handled by the Python bridge
 * as composite operations (calling multiple guard_* functions).
 */

import * as core from "@altimateai/altimate-core"
import { register } from "../dispatcher"
import { schemaOrEmpty, resolveSchema } from "../schema-resolver"
import { preprocessIff, postprocessQualify } from "../altimate-core"
import type {
  SqlAnalyzeResult,
  SqlAnalyzeIssue,
  SqlTranslateResult,
  SqlOptimizeResult,
  SqlOptimizeSuggestion,
  LineageCheckResult,
  SchemaDiffResult,
} from "../types"

/** Register all composite SQL handlers with the Dispatcher.
 *  Exported so tests can re-register after Dispatcher.reset(). */
export function registerAllSql(): void {

// ---------------------------------------------------------------------------
// sql.analyze — lint + semantics + safety
// ---------------------------------------------------------------------------
register("sql.analyze", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const [lintRaw, semanticsRaw, safetyRaw] = await Promise.all([
      core.lint(params.sql, schema),
      core.checkSemantics(params.sql, schema),
      core.scanSql(params.sql),
    ])

    const lint = JSON.parse(JSON.stringify(lintRaw))
    const semantics = JSON.parse(JSON.stringify(semanticsRaw))
    const safety = JSON.parse(JSON.stringify(safetyRaw))

    const issues: SqlAnalyzeIssue[] = []

    for (const f of lint.findings ?? []) {
      issues.push({
        type: "lint",
        severity: f.severity ?? "warning",
        message: f.message ?? f.rule ?? "",
        recommendation: f.suggestion ?? "",
        location: f.line ? `line ${f.line}` : undefined,
        confidence: "high",
      })
    }

    for (const f of semantics.findings ?? []) {
      issues.push({
        type: "semantic",
        severity: f.severity ?? "warning",
        message: f.message ?? "",
        recommendation: f.suggestion ?? f.explanation ?? "",
        confidence: String(f.confidence ?? "medium"),
      })
    }

    for (const t of safety.threats ?? []) {
      issues.push({
        type: "safety",
        severity: t.severity ?? "high",
        message: t.message ?? "",
        recommendation: t.detail ?? "",
        location: t.location ? `chars ${t.location[0]}-${t.location[1]}` : undefined,
        confidence: "high",
      })
    }

    return {
      success: issues.length === 0,
      issues,
      issue_count: issues.length,
      confidence: "high",
      confidence_factors: ["lint", "semantics", "safety"],
    } satisfies SqlAnalyzeResult
  } catch (e) {
    return {
      success: false,
      issues: [],
      issue_count: 0,
      confidence: "low",
      confidence_factors: [],
      error: String(e),
    } satisfies SqlAnalyzeResult
  }
})

// ---------------------------------------------------------------------------
// sql.translate — transpile with IFF/QUALIFY transforms
// ---------------------------------------------------------------------------
register("sql.translate", async (params) => {
  try {
    const processed = preprocessIff(params.sql)
    const raw = core.transpile(processed, params.source_dialect, params.target_dialect)
    const result = JSON.parse(JSON.stringify(raw))

    let translatedSql = result.transpiled_sql?.[0] ?? ""
    const target = params.target_dialect.toLowerCase()
    if (["bigquery", "databricks", "spark", "trino"].includes(target)) {
      if (translatedSql.toUpperCase().includes("QUALIFY")) {
        translatedSql = postprocessQualify(translatedSql)
      }
    }

    return {
      success: result.success ?? true,
      translated_sql: translatedSql,
      source_dialect: params.source_dialect,
      target_dialect: params.target_dialect,
      warnings: result.error ? [result.error] : [],
    } satisfies SqlTranslateResult
  } catch (e) {
    return {
      success: false,
      source_dialect: params.source_dialect,
      target_dialect: params.target_dialect,
      warnings: [],
      error: String(e),
    } satisfies SqlTranslateResult
  }
})

// ---------------------------------------------------------------------------
// sql.optimize — rewrite + lint
// ---------------------------------------------------------------------------
register("sql.optimize", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const [rewriteRaw, lintRaw] = await Promise.all([
      core.rewrite(params.sql, schema),
      core.lint(params.sql, schema),
    ])

    const rewrite = JSON.parse(JSON.stringify(rewriteRaw))
    const lint = JSON.parse(JSON.stringify(lintRaw))

    const suggestions: SqlOptimizeSuggestion[] = (rewrite.suggestions ?? []).map((s: any) => ({
      type: "REWRITE",
      description: s.explanation ?? s.rule ?? "",
      before: params.sql,
      after: s.rewritten_sql,
      impact: s.confidence > 0.7 ? "high" : s.confidence > 0.4 ? "medium" : "low",
    }))

    const antiPatterns = (lint.findings ?? []).map((f: any) => ({
      type: f.rule ?? "lint",
      severity: f.severity ?? "warning",
      message: f.message ?? "",
      recommendation: f.suggestion ?? "",
      location: f.line ? `line ${f.line}` : undefined,
      confidence: "high",
    }))

    const bestRewrite = rewrite.suggestions?.[0]?.rewritten_sql

    return {
      success: true,
      original_sql: params.sql,
      optimized_sql: bestRewrite ?? params.sql,
      suggestions,
      anti_patterns: antiPatterns,
      confidence: suggestions.length > 0 ? "high" : "medium",
    } satisfies SqlOptimizeResult
  } catch (e) {
    return {
      success: false,
      original_sql: params.sql,
      suggestions: [],
      anti_patterns: [],
      confidence: "low",
      error: String(e),
    } satisfies SqlOptimizeResult
  }
})

// ---------------------------------------------------------------------------
// sql.format
// ---------------------------------------------------------------------------
register("sql.format", async (params) => {
  try {
    const raw = core.formatSql(params.sql, params.dialect)
    const result = JSON.parse(JSON.stringify(raw))
    return {
      success: result.success ?? true,
      formatted_sql: result.formatted_sql ?? params.sql,
      dialect: params.dialect ?? "generic",
      error: result.error,
    }
  } catch (e) {
    return { success: false, formatted_sql: params.sql, dialect: params.dialect ?? "generic", error: String(e) }
  }
})

// ---------------------------------------------------------------------------
// sql.fix
// ---------------------------------------------------------------------------
register("sql.fix", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.fix(params.sql, schema)
    const result = JSON.parse(JSON.stringify(raw))

    const suggestions = (result.fixes_applied ?? []).map((f: any) => ({
      type: f.type ?? f.rule ?? "fix",
      message: f.message ?? f.description ?? "",
      confidence: f.confidence ?? "medium",
      fixed_sql: f.fixed_sql ?? f.rewritten_sql,
    }))

    return {
      success: result.fixed ?? true,
      original_sql: result.original_sql ?? params.sql,
      fixed_sql: result.fixed_sql ?? params.sql,
      error_message: params.error_message ?? "",
      suggestions,
      suggestion_count: suggestions.length,
    }
  } catch (e) {
    return {
      success: false,
      original_sql: params.sql,
      fixed_sql: params.sql,
      error_message: params.error_message ?? "",
      suggestions: [],
      suggestion_count: 0,
      error: String(e),
    }
  }
})

// ---------------------------------------------------------------------------
// sql.autocomplete — uses altimate-core complete() + schema cache search
// ---------------------------------------------------------------------------
register("sql.autocomplete", async (params) => {
  try {
    const suggestions: Array<{
      name: string
      type: string
      detail?: string
      fqn?: string
      table?: string
      warehouse?: string
      in_context: boolean
    }> = []

    // Try altimate-core completion if we have a schema context
    if (params.table_context?.length) {
      try {
        const ddl = params.table_context
          .map((t: string) => `CREATE TABLE ${t} (id INT);`)
          .join("\n")
        const schema = core.Schema.fromDdl(ddl)
        const raw = core.complete(params.prefix, params.prefix.length, schema)
        const result = JSON.parse(JSON.stringify(raw))
        for (const item of result.items ?? []) {
          suggestions.push({
            name: item.label,
            type: item.kind ?? "keyword",
            detail: item.detail,
            in_context: true,
          })
        }
      } catch {
        // Fallback to simple keyword suggestions below
      }
    }

    // SQL keyword suggestions as fallback
    if (suggestions.length === 0 && params.prefix) {
      const prefix = params.prefix.toUpperCase()
      const keywords = [
        "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN",
        "INNER JOIN", "GROUP BY", "ORDER BY", "HAVING", "LIMIT",
        "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP",
        "UNION", "UNION ALL", "DISTINCT", "AS", "ON", "AND", "OR",
        "NOT", "IN", "BETWEEN", "LIKE", "IS NULL", "IS NOT NULL",
        "COUNT", "SUM", "AVG", "MIN", "MAX", "CASE", "WHEN", "THEN",
        "ELSE", "END", "EXISTS", "WITH", "OVER", "PARTITION BY",
      ]
      for (const kw of keywords) {
        if (kw.startsWith(prefix)) {
          suggestions.push({ name: kw, type: "keyword", in_context: false })
        }
      }
    }

    const limit = params.limit ?? 50
    return {
      suggestions: suggestions.slice(0, limit),
      prefix: params.prefix,
      position: params.position ?? "",
      suggestion_count: Math.min(suggestions.length, limit),
    }
  } catch (e) {
    return {
      suggestions: [],
      prefix: params.prefix ?? "",
      position: params.position ?? "",
      suggestion_count: 0,
    }
  }
})

// ---------------------------------------------------------------------------
// sql.diff — text diff + equivalence check
// ---------------------------------------------------------------------------
register("sql.diff", async (params) => {
  try {
    const schema = params.schema_context
      ? resolveSchema(undefined, params.schema_context) ?? undefined
      : undefined

    const sqlA = params.original ?? params.sql_a
    const sqlB = params.modified ?? params.sql_b

    const compareRaw = schema
      ? await core.checkEquivalence(sqlA, sqlB, schema)
      : null
    const compare = compareRaw ? JSON.parse(JSON.stringify(compareRaw)) : null

    // Simple line-based diff
    const linesA = sqlA.split("\n")
    const linesB = sqlB.split("\n")
    const diffLines: string[] = []
    const maxLen = Math.max(linesA.length, linesB.length)
    for (let i = 0; i < maxLen; i++) {
      const a = linesA[i] ?? ""
      const b = linesB[i] ?? ""
      if (a !== b) {
        if (a) diffLines.push(`- ${a}`)
        if (b) diffLines.push(`+ ${b}`)
      }
    }

    return {
      success: true,
      diff: diffLines.join("\n"),
      equivalent: compare?.equivalent ?? false,
      equivalence_confidence: compare?.confidence ?? 0,
      differences: compare?.differences ?? [],
    }
  } catch (e) {
    return { success: false, diff: "", equivalent: false, equivalence_confidence: 0, differences: [], error: String(e) }
  }
})

// ---------------------------------------------------------------------------
// sql.rewrite
// ---------------------------------------------------------------------------
register("sql.rewrite", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.rewrite(params.sql, schema)
    const result = JSON.parse(JSON.stringify(raw))
    return {
      success: true,
      original_sql: params.sql,
      rewritten_sql: result.suggestions?.[0]?.rewritten_sql ?? null,
      rewrites_applied: result.suggestions?.map((s: any) => ({
        rule: s.rule,
        original_fragment: params.sql,
        rewritten_fragment: s.rewritten_sql ?? params.sql,
        explanation: s.explanation ?? s.improvement ?? "",
        can_auto_apply: (s.confidence ?? 0) >= 0.7,
      })) ?? [],
    }
  } catch (e) {
    return { success: false, original_sql: params.sql, rewritten_sql: null, rewrites_applied: [], error: String(e) }
  }
})

// ---------------------------------------------------------------------------
// sql.schema_diff
// ---------------------------------------------------------------------------
register("sql.schema_diff", async (params) => {
  try {
    const oldDdl = params.old_sql
    const newDdl = params.new_sql
    const oldSchema = core.Schema.fromDdl(oldDdl, params.dialect || undefined)
    const newSchema = core.Schema.fromDdl(newDdl, params.dialect || undefined)
    const raw = core.diffSchemas(oldSchema, newSchema)
    const result = JSON.parse(JSON.stringify(raw))

    const changes = result.changes ?? []
    const hasBreaking = changes.some((c: any) => c.severity === "breaking")

    return {
      success: true,
      changes,
      has_breaking_changes: hasBreaking,
      summary: result.summary ?? {},
      error: undefined,
    } satisfies SchemaDiffResult
  } catch (e) {
    return {
      success: false,
      changes: [],
      has_breaking_changes: false,
      summary: {},
      error: String(e),
    } satisfies SchemaDiffResult
  }
})

// ---------------------------------------------------------------------------
// lineage.check
// ---------------------------------------------------------------------------
register("lineage.check", async (params) => {
  try {
    const schema = params.schema_context
      ? resolveSchema(undefined, params.schema_context) ?? undefined
      : undefined
    const raw = core.columnLineage(
      params.sql,
      params.dialect ?? undefined,
      schema ?? undefined,
    )
    const result = JSON.parse(JSON.stringify(raw))
    return {
      success: true,
      data: result,
    } satisfies LineageCheckResult
  } catch (e) {
    return {
      success: false,
      data: {},
      error: String(e),
    } satisfies LineageCheckResult
  }
})

} // end registerAllSql

// Auto-register on module load
registerAllSql()
