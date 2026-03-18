/**
 * Native TypeScript handlers for all 34 altimate_core.* bridge methods.
 *
 * This module replaces the Python bridge for altimate-core operations by
 * calling @altimateai/altimate-core napi-rs bindings directly.
 *
 * Each handler wraps the raw altimate-core result into AltimateCoreResult:
 *   { success: boolean, data: Record<string, unknown>, error?: string }
 */

import * as core from "@altimateai/altimate-core"
import { register } from "./dispatcher"
import { schemaOrEmpty, resolveSchema } from "./schema-resolver"
import type { AltimateCoreResult } from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spread a rich TypeScript object into a plain Record for the data field. */
function toData(obj: unknown): Record<string, unknown> {
  if (obj === null || obj === undefined) return {}
  if (typeof obj !== "object") return { value: obj }
  // JSON round-trip to strip class instances / napi references
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>
}

/** Wrap a handler body into the standard AltimateCoreResult envelope. */
function ok(
  success: boolean,
  data: Record<string, unknown>,
): AltimateCoreResult {
  return { success, data }
}

function fail(error: unknown): AltimateCoreResult {
  return { success: false, data: {}, error: String(error) }
}

// ---------------------------------------------------------------------------
// IFF / QUALIFY transpile transforms (ported from Python guard.py)
// ---------------------------------------------------------------------------

const IFF_PATTERN = /\bIFF\s*\(([^,()]+),\s*([^,()]+),\s*([^()]+)\)/gi

/**
 * Iteratively convert Snowflake IFF(cond, a, b) to
 * CASE WHEN cond THEN a ELSE b END.
 */
export function preprocessIff(sql: string): string {
  let current = sql
  for (let i = 0; i < 10; i++) {
    const next = current.replace(
      IFF_PATTERN,
      "CASE WHEN $1 THEN $2 ELSE $3 END",
    )
    if (next === current) break
    current = next
  }
  return current
}

const QUALIFY_PATTERN =
  /\bQUALIFY\b\s+(.+?)(?=\s*(?:LIMIT\s+\d|ORDER\s+BY|;|$))/is

/**
 * Wrap QUALIFY clause into outer SELECT for targets that lack native support.
 */
export function postprocessQualify(sql: string): string {
  const m = QUALIFY_PATTERN.exec(sql)
  if (!m) return sql
  const qualifyExpr = m[1].trim()
  const baseSql = sql.slice(0, m.index).trimEnd()
  const suffix = sql.slice(m.index + m[0].length).trim()
  const wrapped = `SELECT * FROM (${baseSql}) AS _qualify WHERE ${qualifyExpr}`
  return suffix ? `${wrapped} ${suffix}` : wrapped
}

const QUALIFY_TARGETS = new Set(["bigquery", "databricks", "spark", "trino"])

// ---------------------------------------------------------------------------
// Handler registrations
// ---------------------------------------------------------------------------

/** Register all 34 altimate_core.* native handlers with the Dispatcher.
 *  Exported so tests can re-register after Dispatcher.reset(). */
export function registerAll(): void {

// 1. altimate_core.validate
register("altimate_core.validate", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.validate(params.sql, schema)
    const data = toData(raw)
    return ok(data.valid !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 2. altimate_core.lint
register("altimate_core.lint", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.lint(params.sql, schema)
    const data = toData(raw)
    return ok(data.clean !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 3. altimate_core.safety
register("altimate_core.safety", async (params) => {
  try {
    const raw = core.scanSql(params.sql)
    const data = toData(raw)
    return ok(data.safe !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 4. altimate_core.transpile — with IFF/QUALIFY transforms
register("altimate_core.transpile", async (params) => {
  try {
    const processed = preprocessIff(params.sql)
    const raw = core.transpile(processed, params.from_dialect, params.to_dialect)
    const data = toData(raw)

    // Post-process QUALIFY for targets that lack native support
    const targetLower = params.to_dialect.toLowerCase()
    if (QUALIFY_TARGETS.has(targetLower)) {
      const translated =
        (data.sql as string) || (data.translated_sql as string) || ""
      if (translated && translated.toUpperCase().includes("QUALIFY")) {
        const fixed = postprocessQualify(translated)
        if ("sql" in data) {
          data.sql = fixed
        } else {
          data.translated_sql = fixed
        }
      }
    }

    return ok(data.success !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 5. altimate_core.explain
register("altimate_core.explain", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.explain(params.sql, schema)
    const data = toData(raw)
    return ok(data.valid !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 6. altimate_core.check — composite: validate + lint + scan_sql
register("altimate_core.check", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const validation = await core.validate(params.sql, schema)
    const lintResult = core.lint(params.sql, schema)
    const safety = core.scanSql(params.sql)
    const data: Record<string, unknown> = {
      validation: toData(validation),
      lint: toData(lintResult),
      safety: toData(safety),
    }
    return ok(true, data)
  } catch (e) {
    return fail(e)
  }
})

// 7. altimate_core.fix
register("altimate_core.fix", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.fix(
      params.sql,
      schema,
      params.max_iterations ?? undefined,
    )
    const data = toData(raw)
    return ok(data.fixed !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 8. altimate_core.policy
register("altimate_core.policy", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.checkPolicy(params.sql, schema, params.policy_json)
    const data = toData(raw)
    return ok(data.allowed !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 9. altimate_core.semantics
register("altimate_core.semantics", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.checkSemantics(params.sql, schema)
    const data = toData(raw)
    return ok(data.valid !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 10. altimate_core.testgen
register("altimate_core.testgen", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.generateTests(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 11. altimate_core.equivalence
register("altimate_core.equivalence", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.checkEquivalence(params.sql1, params.sql2, schema)
    const data = toData(raw)
    return ok(data.equivalent !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 12. altimate_core.migration
register("altimate_core.migration", async (params) => {
  try {
    // Build schema from old_ddl, analyze new_ddl against it
    const schema = core.Schema.fromDdl(
      params.old_ddl,
      params.dialect || undefined,
    )
    const raw = core.analyzeMigration(params.new_ddl, schema)
    const data = toData(raw)
    return ok(data.safe !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 13. altimate_core.schema_diff
register("altimate_core.schema_diff", async (params) => {
  try {
    const s1 = schemaOrEmpty(params.schema1_path, params.schema1_context)
    const s2 = schemaOrEmpty(params.schema2_path, params.schema2_context)
    const raw = core.diffSchemas(s1, s2)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 14. altimate_core.rewrite
register("altimate_core.rewrite", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.rewrite(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 15. altimate_core.correct
register("altimate_core.correct", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.correct(params.sql, schema)
    const data = toData(raw)
    return ok(data.status !== "unfixable", data)
  } catch (e) {
    return fail(e)
  }
})

// 16. altimate_core.grade
register("altimate_core.grade", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = await core.evaluate(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 17. altimate_core.classify_pii
register("altimate_core.classify_pii", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.classifyPii(schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 18. altimate_core.query_pii
register("altimate_core.query_pii", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.checkQueryPii(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 19. altimate_core.resolve_term
register("altimate_core.resolve_term", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.resolveTerm(params.term, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 20. altimate_core.column_lineage
register("altimate_core.column_lineage", async (params) => {
  try {
    const schema = resolveSchema(params.schema_path, params.schema_context)
    const raw = core.columnLineage(
      params.sql,
      params.dialect || undefined,
      schema ?? undefined,
    )
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 21. altimate_core.track_lineage
register("altimate_core.track_lineage", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.trackLineage(params.queries, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 22. altimate_core.format
register("altimate_core.format", async (params) => {
  try {
    const raw = core.formatSql(params.sql, params.dialect || undefined)
    const data = toData(raw)
    return ok(data.success !== false, data)
  } catch (e) {
    return fail(e)
  }
})

// 23. altimate_core.metadata
register("altimate_core.metadata", async (params) => {
  try {
    const raw = core.extractMetadata(params.sql, params.dialect || undefined)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 24. altimate_core.compare
register("altimate_core.compare", async (params) => {
  try {
    const raw = core.compareQueries(
      params.left_sql,
      params.right_sql,
      params.dialect || undefined,
    )
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 25. altimate_core.complete
register("altimate_core.complete", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.complete(params.sql, params.cursor_pos, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 26. altimate_core.optimize_context
register("altimate_core.optimize_context", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.optimizeContext(schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 27. altimate_core.optimize_for_query
register("altimate_core.optimize_for_query", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.optimizeForQuery(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 28. altimate_core.prune_schema
register("altimate_core.prune_schema", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const raw = core.pruneSchema(params.sql, schema)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 29. altimate_core.import_ddl — returns Schema, must serialize
register("altimate_core.import_ddl", async (params) => {
  try {
    const schema = core.importDdl(params.ddl, params.dialect || undefined)
    const jsonObj = schema.toJson()
    return ok(true, { success: true, schema: toData(jsonObj) })
  } catch (e) {
    return fail(e)
  }
})

// 30. altimate_core.export_ddl — returns string
register("altimate_core.export_ddl", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const ddl = core.exportDdl(schema)
    return ok(true, { success: true, ddl })
  } catch (e) {
    return fail(e)
  }
})

// 31. altimate_core.fingerprint — returns string hash
register("altimate_core.fingerprint", async (params) => {
  try {
    const schema = schemaOrEmpty(params.schema_path, params.schema_context)
    const fingerprint = core.schemaFingerprint(schema)
    return ok(true, { success: true, fingerprint })
  } catch (e) {
    return fail(e)
  }
})

// 32. altimate_core.introspection_sql
register("altimate_core.introspection_sql", async (params) => {
  try {
    const raw = core.introspectionSql(
      params.db_type,
      params.database,
      params.schema_name ?? undefined,
    )
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 33. altimate_core.parse_dbt
register("altimate_core.parse_dbt", async (params) => {
  try {
    const raw = core.parseDbtProject(params.project_dir)
    return ok(true, toData(raw))
  } catch (e) {
    return fail(e)
  }
})

// 34. altimate_core.is_safe — returns boolean
register("altimate_core.is_safe", async (params) => {
  try {
    const safe = core.isSafe(params.sql)
    return ok(true, { safe })
  } catch (e) {
    return fail(e)
  }
})

} // end registerAll

// Auto-register on module load
registerAll()
