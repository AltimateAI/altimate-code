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
import { EngineCoerce } from "./engine-coerce"
import { register } from "./dispatcher"
import { schemaOrEmpty, resolveSchema, SchemaResolver } from "./schema-resolver"
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

/**
 * Wrap a handler body into the standard AltimateCoreResult envelope.
 *
 * Contract: ok(true, data) means "the operation completed." Semantic results
 * (e.g., SQL is invalid, queries are not equivalent) live in the data fields,
 * NOT in the success flag. success=false only when the handler throws (fail()).
 * This prevents semantic findings from being misreported as tool crashes.
 */
function ok(success: boolean, data: Record<string, unknown>): AltimateCoreResult {
  return { success, data }
}

function fail(error: unknown): AltimateCoreResult {
  return { success: false, data: {}, error: String(error) }
}

/** Redact raw-input echoes from a scan result's threats (see EngineCoerce.redactThreatText). */
function redactScan(scan: Record<string, unknown>): Record<string, unknown> {
  const threats = (scan.threats as any[] | undefined)?.map((t: any) => ({
    ...t,
    message: typeof t.message === "string" ? EngineCoerce.redactThreatText(t.message) : t.message,
    detail: typeof t.detail === "string" ? EngineCoerce.redactThreatText(t.detail) : t.detail,
    // For multi_statement the matched pattern IS the raw input line — an
    // arbitrary-file content echo. Injection rules keep their SQL-shaped
    // patterns (useful, and inherently query-derived).
    matched_pattern: t.rule === "multi_statement" ? "<redacted>" : t.matched_pattern,
  }))
  return threats ? { ...scan, threats } : scan
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
    const next = current.replace(IFF_PATTERN, "CASE WHEN $1 THEN $2 ELSE $3 END")
    if (next === current) break
    current = next
  }
  return current
}

const QUALIFY_PATTERN = /\bQUALIFY\b\s+(.+?)(?=\s*(?:LIMIT\s+\d|ORDER\s+BY|;|$))/is

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
      return ok(true, data)
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
      return ok(true, data)
    } catch (e) {
      return fail(e)
    }
  })

  // 3. altimate_core.safety
  register("altimate_core.safety", async (params) => {
    try {
      const raw = core.scanSql(params.sql)
      const data = redactScan(toData(raw))
      return ok(true, data)
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
        // Rust returns transpiled_sql as string[] — use first element
        const transpiled = Array.isArray(data.transpiled_sql)
          ? (data.transpiled_sql as string[])[0]
          : (data.transpiled_sql as string) || (data.sql as string) || (data.translated_sql as string) || ""
        if (transpiled && transpiled.toUpperCase().includes("QUALIFY")) {
          const fixed = postprocessQualify(transpiled)
          if (Array.isArray(data.transpiled_sql)) {
            ;(data.transpiled_sql as string[])[0] = fixed
          } else if ("sql" in data) {
            data.sql = fixed
          } else {
            data.translated_sql = fixed
          }
        }
      }

      return ok(true, data)
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
      return ok(true, data)
    } catch (e) {
      return fail(e)
    }
  })

  // 6. altimate_core.check — composite: validate + lint + scan_sql
  register("altimate_core.check", async (params) => {
    try {
      const schema = schemaOrEmpty(params.schema_path, params.schema_context)
      // NOTE: validation is deliberately NOT diff-scoped against base_sql.
      // The engine validates fail-fast (only the FIRST error is reported), so
      // subtracting base errors can hide genuinely new breakage behind a
      // pre-existing one. Re-reporting a pre-existing error is the safe mode.
      const validation: Record<string, unknown> = toData(await core.validate(params.sql, schema))
      // Diff-scoped lint: when a base SQL is supplied, core returns only the
      // findings the change INTRODUCED (pre-existing issues in the file are
      // dropped) — the structural comparison stays in the AST engine.
      const lintResult =
        params.base_sql && typeof core.lintDiff === "function"
          ? core.lintDiff(
              params.sql,
              params.base_sql,
              // lintDiff takes SchemaDefinition JSON — normalize flat agent
              // schemas too, or the whole composite throws "missing field tables".
              params.schema_context ? SchemaResolver.normalizeSchemaContext(params.schema_context) : undefined,
            )
          : core.lint(params.sql, schema)
      // Diff-scope safety like lint: threats present in the base SQL are
      // pre-existing, not introduced by this change. Subtract as a MULTISET on
      // (rule, matched_pattern) — one base occurrence consumes one head
      // occurrence, so a PR that ADDS a second identical injection still
      // reports it. Recompute safe/risk_score from the surviving threats so a
      // fully pre-existing threat set doesn't leave a stale unsafe verdict.
      let safety: Record<string, unknown> = redactScan(toData(core.scanSql(params.sql)))
      if (params.base_sql) {
        try {
          const baseCounts = new Map<string, number>()
          for (const t of core.scanSql(params.base_sql).threats) {
            const k = `${t.rule}|${t.matched_pattern}`
            baseCounts.set(k, (baseCounts.get(k) ?? 0) + 1)
          }
          const remaining = (safety.threats as any[]).filter((t: any) => {
            const k = `${t.rule}|${t.matched_pattern}`
            const left = baseCounts.get(k) ?? 0
            if (left > 0) {
              baseCounts.set(k, left - 1)
              return false
            }
            return true
          })
          // The engine's risk_score covers the FULL head scan — once threats
          // are filtered it no longer matches. Recompute a documented
          // approximation from the surviving severities (matches the engine's
          // observed single-threat scores closely enough for gating).
          const severityScore: Record<string, number> = { critical: 0.98, high: 0.95, medium: 0.6, low: 0.3 }
          const rescored =
            remaining.length === (safety.threats as any[]).length
              ? (safety.risk_score as number)
              : remaining.reduce((m: number, t: any) => Math.max(m, severityScore[t.severity] ?? 0.5), 0)
          safety = {
            ...safety,
            threats: remaining,
            safe: remaining.length === 0 ? true : safety.safe,
            risk_score: rescored,
          }
        } catch {
          // Unscannable base — keep the full head scan (fail open to MORE findings).
        }
      }
      // PII exposure for the composite check — the tool has always rendered a
      // PII section; previously nothing populated it. Additive: a PII failure
      // must not fail the whole composite.
      let pii: Record<string, unknown>
      try {
        pii = toData(core.checkQueryPii(params.sql, schema))
        if (params.base_sql && Array.isArray(pii.pii_columns) && (pii.pii_columns as any[]).length) {
          try {
            // Pre-existing exposures are not introduced by this change. The
            // identity INCLUDES the sorted output aliases — adding or renaming
            // a SELECT-list alias for an already-exposed column is a NEW
            // output exposure and must still surface.
            const exposureKey = (c: any) =>
              `${c.table}|${c.column}|${[...(c.query_targets ?? [])].sort().join(",")}`
            const baseExposed = new Set(core.checkQueryPii(params.base_sql, schema).pii_columns.map(exposureKey))
            const remaining = (pii.pii_columns as any[]).filter((c: any) => !baseExposed.has(exposureKey(c)))
            pii = {
              ...pii,
              pii_columns: remaining,
              accesses_pii: remaining.length > 0 ? pii.accesses_pii : false,
              // risk_level covered the full head report; with no surviving
              // exposures it must not keep claiming risk.
              risk_level: remaining.length === 0 ? "None" : pii.risk_level,
            }
          } catch {
            // Unscannable base — keep the full head exposure list.
          }
        }
      } catch (e) {
        // Mark as an abstention — an empty object would render "No PII
        // detected", a false-clean verdict.
        pii = { parse_error: String(e) }
      }
      const data: Record<string, unknown> = {
        validation,
        lint: toData(lintResult),
        safety: toData(safety),
        pii,
      }
      return ok(true, data)
    } catch (e) {
      return fail(e)
    }
  })

  // altimate_change start — dbt-pr-review IP lives in the compiled core, not public TS
  // The AI reviewer's system prompt and the response parse/clamp logic ship as a
  // binary; the TS layer only transports the LLM call.
  register("altimate_core.review_ai_prompt", async () => {
    try {
      return ok(true, { prompt: core.reviewAiSystemPrompt() })
    } catch (e) {
      return fail(e)
    }
  })
  register("altimate_core.review_ai_parse", async (params) => {
    try {
      const json = core.reviewAiParse(params.text, params.valid_files ?? [])
      return ok(true, { findings: JSON.parse(json) })
    } catch (e) {
      return fail(e)
    }
  })
  // Lexical scan (reserved-word aliases + dialect operators) — curated lists +
  // detection embedded in the binary; TS passes the raw added diff lines.
  register("altimate_core.review_lexical_scan", async (params) => {
    try {
      const json = core.reviewLexicalScan(params.added_lines ?? [])
      return ok(true, { findings: JSON.parse(json) })
    } catch (e) {
      return fail(e)
    }
  })

  // Grain extraction (final-SELECT GROUP BY + dedup PARTITION BY) for grain-vs-PK
  // mismatch detection in PR review. Parsing lives in core; the comparison to the
  // declared key is plumbing done in the orchestrator.
  register("altimate_core.grain", async (params) => {
    try {
      const json = core.extractGrain(params.sql)
      return ok(true, JSON.parse(json))
    } catch (e) {
      return fail(e)
    }
  })

  // Per-upstream WHERE-filter columns, for cross-model sibling filter-consistency.
  register("altimate_core.source_filters", async (params) => {
    try {
      return ok(true, { filters: JSON.parse(core.extractSourceFilters(params.sql)) })
    } catch (e) {
      return fail(e)
    }
  })

  // dbt config/Jinja lint over a RAW model ({{ config() }} parsed by minijinja in core).
  register("altimate_core.dbt_config_lint", async (params) => {
    try {
      return ok(true, { findings: JSON.parse(core.dbtConfigLint(params.sql)) })
    } catch (e) {
      return fail(e)
    }
  })
  register("altimate_core.dbt_config_diff", async (params) => {
    try {
      return ok(true, { findings: JSON.parse(core.dbtConfigDiff(params.base_sql ?? "", params.head_sql ?? "")) })
    } catch (e) {
      return fail(e)
    }
  })
  // AST base-vs-head structural diff — the `*_change` SQL rules, moved off diff-line regex.
  register("altimate_core.structural_diff", async (params) => {
    try {
      return ok(true, {
        findings: JSON.parse(core.reviewStructuralDiff(params.base_sql ?? "", params.head_sql ?? "")),
      })
    } catch (e) {
      return fail(e)
    }
  })
  // altimate_change end

  // 7. altimate_core.fix
  register("altimate_core.fix", async (params) => {
    try {
      const schema = schemaOrEmpty(params.schema_path, params.schema_context)
      const raw = await core.fix(params.sql, schema, params.max_iterations ?? undefined)
      const data = toData(raw)
      return ok(true, data)
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
      return ok(true, data)
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
      return ok(true, data)
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
      // Pass the optional dialect hint so dialect-specific compiled warehouse SQL
      // (e.g. Snowflake semi-structured `col:field`) parses and the pair is
      // decidable instead of abstaining on a syntax error. Supported since
      // altimate-core@0.5.1. dialectHint coerces "" (the ReviewConfig default)
      // to undefined: the engine throws on an unknown dialect "", and "" must
      // mean auto-detect, not a real dialect.
      const raw = await core.checkEquivalence(params.sql1, params.sql2, schema, EngineCoerce.dialectHint(params.dialect))
      const data = toData(raw)
      return ok(true, data)
    } catch (e) {
      return fail(e)
    }
  })

  // 12. altimate_core.migration
  register("altimate_core.migration", async (params) => {
    try {
      // Build schema from old_ddl, analyze new_ddl against it. dialectHint
      // coerces "" to auto-detect (the engine throws on an unknown dialect "").
      const schema = core.Schema.fromDdl(params.old_ddl, EngineCoerce.dialectHint(params.dialect))
      const raw = core.analyzeMigration(params.new_ddl, schema)
      const data = toData(raw)
      return ok(true, data)
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
      return ok(true, data)
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

  // 19. altimate_core.resolve_term — returns array, must wrap
  register("altimate_core.resolve_term", async (params) => {
    try {
      const schema = schemaOrEmpty(params.schema_path, params.schema_context)
      const raw = core.resolveTerm(params.term, schema)
      // Rust returns an array of matches — wrap for consistent object shape
      const matches = Array.isArray(raw) ? JSON.parse(JSON.stringify(raw)) : []
      return ok(true, { matches })
    } catch (e) {
      return fail(e)
    }
  })

  // 20. altimate_core.column_lineage
  register("altimate_core.column_lineage", async (params) => {
    try {
      const schema = resolveSchema(params.schema_path, params.schema_context)
      const raw = core.columnLineage(params.sql, EngineCoerce.dialectHint(params.dialect), schema ?? undefined)
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
      const raw = core.formatSql(params.sql, EngineCoerce.dialectHint(params.dialect))
      const data = toData(raw)
      return ok(true, data)
    } catch (e) {
      return fail(e)
    }
  })

  // 23. altimate_core.metadata
  register("altimate_core.metadata", async (params) => {
    try {
      const raw = core.extractMetadata(params.sql, EngineCoerce.dialectHint(params.dialect))
      return ok(true, toData(raw))
    } catch (e) {
      return fail(e)
    }
  })

  // 24. altimate_core.compare
  register("altimate_core.compare", async (params) => {
    try {
      const raw = core.compareQueries(params.left_sql, params.right_sql, EngineCoerce.dialectHint(params.dialect))
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
      const schema = core.importDdl(params.ddl, EngineCoerce.dialectHint(params.dialect))
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
      const raw = core.introspectionSql(params.db_type, params.database, params.schema_name ?? undefined)
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
