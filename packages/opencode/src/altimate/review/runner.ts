import { Dispatcher } from "../native"
import { parseManifest } from "../native/dbt/manifest"
import type { CheckResult, EquivalenceResult, GradeResult, ImpactResult, ReviewRunner } from "./orchestrate"
import { buildReviewSchemaContext, type SchemaContext } from "./schema-context"

/**
 * Production ReviewRunner backed by the native Dispatcher (the Rust core).
 *
 * Every method is defensive: on any error or unexpected shape it degrades to a
 * safe, lint-only result rather than throwing — a review must never crash CI.
 * That is the "degrade loudly" contract: when the manifest/schema is missing,
 * findings are emitted as unverified rather than silently dropped or fabricated.
 */

interface ManifestModel {
  unique_id: string
  name: string
  depends_on: string[]
  path?: string
}

interface CachedManifest {
  models: Map<string, ManifestModel> // unique_id -> model
  byName: Map<string, ManifestModel>
  children: Map<string, string[]> // unique_id -> direct child unique_ids
  testDeps: Map<string, Set<string>> // model unique_id -> set of test unique_ids depending on it
  schemaContext?: SchemaContext // model/source columns for equivalence resolution
  ok: boolean
}

function asArray<T = any>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

/**
 * Copy `primary_key` from `source` (manifest, which has dbt contract PKs) onto
 * matching tables in `target` (catalog, which has complete columns but no PK).
 * Non-destructive: only fills a PK where `target` lacks one. Enables fan-out
 * detection (L037) on the catalog-preferred path.
 */
function mergePrimaryKeys(
  target: Record<string, any> | undefined,
  source: Record<string, any> | undefined,
): Record<string, any> | undefined {
  if (!target?.tables || !source?.tables) return target
  const out = { ...target, tables: { ...target.tables } }
  for (const [key, t] of Object.entries<any>(out.tables)) {
    if (t?.primary_key?.length) continue
    const pk = source.tables[key]?.primary_key
    if (Array.isArray(pk) && pk.length) out.tables[key] = { ...t, primary_key: pk }
  }
  return out
}

/** Extract a column name from a PII-flavored check issue, best-effort. */
function piiColumnOf(issue: any): string | undefined {
  return issue?.column ?? issue?.target ?? issue?.name ?? undefined
}

/** The engine returns a numeric confidence (0..1); map it to a band. */
function bandConfidence(c: unknown): "high" | "medium" | "low" {
  if (typeof c === "string") {
    const s = c.toLowerCase()
    if (s === "high" || s === "medium" || s === "low") return s
  }
  const n = typeof c === "number" ? c : 0.5
  return n >= 0.8 ? "high" : n >= 0.5 ? "medium" : "low"
}

/**
 * Map a core lint finding (by rule name / L0xx code) to a review category.
 * Core's `LintFinding` carries no category, so without this every AST finding
 * collapses to `sql_quality` — undersells correctness/join/contract risks.
 */
function lintCategory(rule: string, code: string): string | undefined {
  const r = `${rule} ${code}`.toLowerCase().replace(/_/g, "-")
  if (/pii|sensitive/.test(r)) return "pii_exposure"
  if (/cartesian|cross-join|comma-join|non-equi-join|or-in-join|fan.?out|l037/.test(r)) return "join_risk"
  if (/non-portable-type|l035/.test(r)) return "contract_violation"
  if (/division|divide|l032/.test(r)) return "sql_correctness"
  if (/overflow|l036/.test(r)) return "sql_correctness"
  if (/timezone-in-hash|hash-key|l038/.test(r)) return "sql_correctness"
  if (/non-deterministic|dedup|l039/.test(r)) return "sql_correctness"
  if (/monetary|float-cast|l040/.test(r)) return "sql_correctness"
  if (/coalesce|typed-coalesce|l041/.test(r)) return "sql_correctness"
  if (/case-sensitive|l042/.test(r)) return "sql_quality"
  if (/outer-join-filter|outer_join|left-to-inner|l043/.test(r)) return "join_risk"
  if (/null-propagating|null.?concat|l044/.test(r)) return "sql_correctness"
  if (/greatest|least|l045/.test(r)) return "sql_correctness"
  if (/distinct.?with.?window|l046/.test(r)) return "sql_correctness"
  if (/cast.?division|cast.?float|l048/.test(r)) return "sql_correctness"
  if (/clock.?in.?filter|now.?in.?filter|l049/.test(r)) return "idempotency"
  if (/cast.?in.?join|join-on-cast|l050/.test(r)) return "join_risk"
  if (/full.?outer|join.?without.?cond|l051|l052/.test(r)) return "join_risk"
  if (/null.?in.?in.?list|sum.?of.?ratio|l053|l054/.test(r)) return "sql_correctness"
  if (/not-null-comparison|null-comparison|not-in|nullable|l009/.test(r)) return "sql_correctness"
  if (/window.*partition|partition.*window/.test(r)) return "sql_correctness"
  if (/count-star|distinct/.test(r)) return "sql_correctness"
  if (/missing-where|update|delete/.test(r)) return "sql_correctness"
  if (/non-portable-function|l033/.test(r)) return "sql_quality"
  if (/select-star|l001|leading-wildcard|missing-partition-filter|large-in-list|non-sargable/.test(r))
    return "warehouse_cost"
  return undefined // → sql_quality default downstream
}

export interface DispatcherRunnerOptions {
  manifestPath: string
  /** Optional inline schema context to enable real equivalence proofs. */
  schemaContext?: Record<string, any>
}

export function createDispatcherRunner(opts: DispatcherRunnerOptions): ReviewRunner {
  const checkCache = new Map<string, CheckResult>()
  let manifestPromise: Promise<CachedManifest> | undefined

  async function loadManifest(): Promise<CachedManifest> {
    if (!manifestPromise) {
      manifestPromise = (async () => {
        try {
          // Manifest parsing is pure TypeScript. Keep it independent from the
          // native dispatcher registration path so a core-loading failure
          // cannot incorrectly downgrade a valid dbt run to lint-only.
          const res = await parseManifest({ path: opts.manifestPath })
          const models = new Map<string, ManifestModel>()
          const byName = new Map<string, ManifestModel>()
          const children = new Map<string, string[]>()
          const nodes = [...asArray<ManifestModel>(res.models), ...asArray<ManifestModel>((res as any).snapshots)]
          for (const m of nodes) {
            models.set(m.unique_id, m)
            byName.set(m.name, m)
          }
          // Invert depends_on (upstream) into children (downstream).
          for (const m of nodes) {
            for (const parent of asArray<string>(m.depends_on)) {
              if (!children.has(parent)) children.set(parent, [])
              children.get(parent)!.push(m.unique_id)
            }
          }
          // Map each model to the SET of tests depending on it (by test
          // unique_id), so a multi-model test isn't counted more than once.
          const testDeps = new Map<string, Set<string>>()
          for (const t of asArray<{ unique_id: string; depends_on: string[] }>(res.tests)) {
            for (const dep of asArray<string>(t.depends_on)) {
              if (!testDeps.has(dep)) testDeps.set(dep, new Set())
              testDeps.get(dep)!.add(t.unique_id)
            }
          }
          // Schema context (model/source/seed/snapshot columns) for equivalence.
          const schemaContext = buildReviewSchemaContext(
            asArray(res.models),
            asArray(res.sources),
            asArray(res.seeds),
            asArray((res as any).snapshots),
          )
          return { models, byName, children, testDeps, schemaContext, ok: models.size > 0 }
        } catch {
          return {
            models: new Map(),
            byName: new Map(),
            children: new Map(),
            testDeps: new Map(),
            ok: false,
          }
        }
      })()
    }
    return manifestPromise
  }

  // Explicit override wins; otherwise derive schema from the manifest. This is
  // what makes equivalence decidable in CI instead of always-undecidable.
  let mergedSchema: Record<string, any> | undefined
  let mergedSchemaDone = false
  async function resolveSchema(): Promise<Record<string, any> | undefined> {
    if (!opts.schemaContext) return (await loadManifest()).schemaContext
    // The catalog schema has complete warehouse columns but no PRIMARY KEY concept;
    // enrich it with PKs from the manifest (dbt contract constraints) so fan-out
    // detection (L037) can fire. Memoized so the merge happens at most once.
    if (!mergedSchemaDone) {
      mergedSchema = mergePrimaryKeys(opts.schemaContext, (await loadManifest()).schemaContext)
      mergedSchemaDone = true
    }
    return mergedSchema
  }

  async function runCheck(sql: string, dialect?: string, baseSql?: string): Promise<CheckResult> {
    // Key on the base SQL VALUE, not just its presence: diff-scoped checks
    // compare new-vs-base, so two calls with the same new SQL but a different
    // base must not collide (otherwise findings bleed between comparisons).
    const cacheKey = `${dialect ?? ""}|${baseSql ?? ""}|${sql}`
    const cached = checkCache.get(cacheKey)
    if (cached) return cached
    let out: CheckResult = { issues: [], piiColumns: [] }
    try {
      // Thread the project dialect into the schema so core lint runs in the
      // right dialect (e.g. L033 portability suppresses the warehouse's OWN
      // native functions) — in BOTH full and lint-only modes. core's schema
      // validation requires ≥1 table, so when there's no manifest we attach a
      // throwaway table purely to carry the dialect; AST lint walks the query,
      // not the schema, so it's inert (and validation errors aren't surfaced).
      const schema = (await resolveSchema()) as { tables?: Record<string, unknown> } | undefined
      const hasTables = !!schema && Object.keys(schema.tables ?? {}).length > 0
      const schemaContext = !dialect
        ? schema
        : hasTables
          ? { ...schema, dialect }
          : { tables: { _altimate_lint_: { columns: [{ name: "_", type: "string" }] } }, version: "1", dialect }
      const res = await Dispatcher.call("altimate_core.check", { sql, schema_context: schemaContext, base_sql: baseSql })
      const data = (res.data ?? {}) as Record<string, any>
      // `altimate_core.check` is a composite: { validation, lint, safety }.
      // The AST anti-pattern findings live at data.lint.findings (each a
      // LintFinding: { code, rule, severity, message, line }). Validation
      // failures surface as data.validation.errors. We also keep the legacy
      // top-level keys as a fallback for older core builds.
      const rawIssues = asArray(data.lint?.findings)
        .concat(asArray(data.issues))
        .concat(asArray(data.violations))
        .concat(asArray(data.findings))
      const issues = rawIssues.map((i: any) => ({
        rule: i.rule ?? i.code ?? i.name ?? "issue",
        message: i.message ?? i.description ?? String(i),
        line: typeof i.line === "number" ? i.line : i.location?.line,
        severity: i.severity ?? i.level,
        category: i.category ?? lintCategory(String(i.rule ?? ""), String(i.code ?? "")) ?? i.kind,
      }))
      // PII columns: explicit data.pii, or PII-categorized issues. Extract from
      // RAW issues (which still carry column/target/name) — the normalized
      // `issues` drop those fields, so mapping over them would always miss.
      const piiColumns = [
        ...asArray<any>(data.pii).map(piiColumnOf),
        ...rawIssues
          .filter((i: any) => /pii|sensitive/i.test(String(i.category ?? i.rule ?? i.code ?? i.kind ?? "")))
          .map(piiColumnOf),
      ].filter((c): c is string => !!c)
      // ran=true: the core parsed and analyzed the SQL (even if zero issues).
      // This lets the orchestrator defer structural checks to the AST lint.
      out = { issues, piiColumns: [...new Set(piiColumns)], ran: true }
    } catch {
      out = { issues: [], piiColumns: [], ran: false }
    }
    checkCache.set(cacheKey, out)
    return out
  }

  return {
    async manifestAvailable(): Promise<boolean> {
      return (await loadManifest()).ok
    },

    async impact(model: string): Promise<ImpactResult> {
      const mf = await loadManifest()
      if (!mf.ok) {
        return { hasManifest: false, severity: "UNKNOWN", directCount: 0, transitiveCount: 0, testCount: 0 }
      }
      const target = mf.byName.get(model) ?? [...mf.models.values()].find((m) => m.name.endsWith(`.${model}`))
      if (!target) {
        return { hasManifest: true, severity: "SAFE", directCount: 0, transitiveCount: 0, testCount: 0 }
      }
      const direct = new Set(mf.children.get(target.unique_id) ?? [])
      const all = new Set<string>(direct)
      const queue = [...direct]
      while (queue.length) {
        const id = queue.shift()!
        for (const child of mf.children.get(id) ?? []) {
          if (!all.has(child)) {
            all.add(child)
            queue.push(child)
          }
        }
      }
      const transitive = [...all].filter((id) => !direct.has(id))
      // Distinct tests across the target + all downstream (a test asserting on
      // several of them counts once).
      const affectedTests = new Set<string>()
      for (const id of [target.unique_id, ...all]) {
        for (const tid of mf.testDeps.get(id) ?? []) affectedTests.add(tid)
      }
      const testCount = affectedTests.size
      const total = all.size
      const severity = total === 0 ? "SAFE" : total <= 3 ? "LOW" : total <= 10 ? "MEDIUM" : "HIGH"
      return {
        hasManifest: true,
        severity,
        directCount: direct.size,
        transitiveCount: transitive.length,
        testCount,
      }
    },

    async grade(sql: string): Promise<GradeResult> {
      try {
        const res = await Dispatcher.call("altimate_core.grade", { sql, schema_context: await resolveSchema() })
        const data = (res.data ?? {}) as Record<string, any>
        return { grade: data.grade ?? data.overall_grade }
      } catch {
        return {}
      }
    },

    check(sql: string, dialect?: string, baseSql?: string): Promise<CheckResult> {
      return runCheck(sql, dialect, baseSql)
    },

    async grain(sql: string): Promise<{ group_by: string[]; dedup_partition: string[] }> {
      try {
        const res = await Dispatcher.call("altimate_core.grain", { sql })
        const d = (res.data ?? {}) as Record<string, any>
        return { group_by: asArray<string>(d.group_by), dedup_partition: asArray<string>(d.dedup_partition) }
      } catch {
        return { group_by: [], dedup_partition: [] }
      }
    },

    async dbtConfigLint(
      rawSql: string,
      oldRawSql?: string,
    ): Promise<Array<{ code: string; rule: string; severity?: string; message: string; suggestion?: string }>> {
      const out: any[] = []
      try {
        const res = await Dispatcher.call("altimate_core.dbt_config_lint", { sql: rawSql })
        out.push(...asArray((res.data as any)?.findings))
      } catch {
        /* skip */
      }
      if (oldRawSql) {
        try {
          const res = await Dispatcher.call("altimate_core.dbt_config_diff", { base_sql: oldRawSql, head_sql: rawSql })
          out.push(...asArray((res.data as any)?.findings))
        } catch {
          /* skip */
        }
      }
      return out
    },

    async structuralDiff(
      baseSql: string,
      headSql: string,
    ): Promise<Array<{ code: string; rule: string; severity?: string; message: string; suggestion?: string }>> {
      try {
        const res = await Dispatcher.call("altimate_core.structural_diff", { base_sql: baseSql, head_sql: headSql })
        return asArray((res.data as any)?.findings)
      } catch {
        return []
      }
    },

    async sourceFilters(sql: string): Promise<Record<string, string[]>> {
      try {
        const res = await Dispatcher.call("altimate_core.source_filters", { sql })
        const d = (res.data ?? {}) as Record<string, any>
        return (d.filters ?? {}) as Record<string, string[]>
      } catch {
        return {}
      }
    },

    async declaredPrimaryKey(model: string): Promise<string[] | undefined> {
      const schema = (await resolveSchema()) as { tables?: Record<string, any> } | undefined
      const t = schema?.tables?.[model] ?? schema?.tables?.[model.toLowerCase()]
      const pk = t?.primary_key
      return Array.isArray(pk) && pk.length ? pk.map((c: string) => String(c)) : undefined
    },

    async downstreamModels(model: string): Promise<Array<{ name: string; path: string }>> {
      const m = await loadManifest()
      const node = m.byName.get(model)
      if (!node) return []
      const out: Array<{ name: string; path: string }> = []
      for (const childId of m.children.get(node.unique_id) ?? []) {
        const child = m.models.get(childId)
        if (child?.path && childId.startsWith("model.")) out.push({ name: child.name, path: child.path })
      }
      return out
    },

    async isComplex(sql: string): Promise<boolean> {
      try {
        const res = await Dispatcher.call("altimate_core.metadata", { sql })
        const d = (res.data ?? {}) as Record<string, any>
        return !!(d.has_window_functions || d.has_subqueries || (typeof d.node_count === "number" && d.node_count >= 12))
      } catch {
        return false
      }
    },

    async classifyPii(columns: string[]) {
      if (!columns.length) return []
      try {
        // classify_pii classifies a SCHEMA's columns by name/type — feed it the
        // model's output columns as a one-table schema.
        const res = await Dispatcher.call("altimate_core.classify_pii", {
          schema_context: {
            tables: { model: { columns: columns.map((name) => ({ name, type: "string" })) } },
            version: "1",
          },
        })
        const data = (res.data ?? {}) as Record<string, any>
        return asArray<any>(data.columns)
          .filter((c) => c?.classification && c.classification !== "None")
          .map((c) => ({
            column: String(c.column ?? ""),
            classification: String(c.classification ?? ""),
            confidence: typeof c.confidence === "number" ? c.confidence : 0,
            masking: c.suggested_masking ?? undefined,
          }))
      } catch {
        return []
      }
    },

    async dataDiff(baseSql: string, headSql: string, keyColumns: string[], warehouse?: string) {
      if (!keyColumns.length) return null
      try {
        // Both sides run against the SAME warehouse connection (base-compiled vs
        // head-compiled SQL). `warehouse` selects a named connection; when empty,
        // `data.diff` falls back to the default/first registered warehouse.
        const res = await Dispatcher.call("data.diff", {
          source: baseSql,
          target: headSql,
          key_columns: keyColumns,
          source_warehouse: warehouse || undefined,
          target_warehouse: warehouse || undefined,
        })
        const r = res as any
        if (!r || r.success === false) return null
        const o = (r.outcome ?? {}) as Record<string, any>
        return {
          rowsOnlyInBase: o.rows_only_in_source ?? o.removed ?? o.exclusive_source,
          rowsOnlyInHead: o.rows_only_in_target ?? o.added ?? o.exclusive_target,
          rowsChanged: o.rows_changed ?? o.different ?? o.changed,
          summary: o.summary ?? r.summary,
        }
      } catch {
        return null
      }
    },

    async columnLineage(sql: string, dialect?: string): Promise<Array<{ source: string; target: string }>> {
      try {
        const res = await Dispatcher.call("altimate_core.column_lineage", {
          sql,
          schema_path: "",
          schema_context: await resolveSchema(),
          dialect,
        })
        const data = (res.data ?? {}) as Record<string, any>
        return asArray<any>(data.column_lineage).map((e) => ({
          source: String(e.source ?? ""),
          target: String(e.target ?? ""),
        }))
      } catch {
        return []
      }
    },

    async lexicalScan(addedLines: string[]) {
      if (!addedLines.length) return []
      try {
        const res = await Dispatcher.call("altimate_core.review_lexical_scan", { added_lines: addedLines })
        const data = (res.data ?? {}) as Record<string, any>
        return asArray<any>(data.findings).map((f) => ({
          rule: String(f.rule ?? "lexical"),
          severity: f.severity,
          message: String(f.message ?? ""),
          line: f.line,
        }))
      } catch {
        return []
      }
    },

    async equivalence(oldSql: string, newSql: string, dialect?: string): Promise<EquivalenceResult> {
      try {
        const schema = await resolveSchema()
        const res = await Dispatcher.call("altimate_core.equivalence", {
          sql1: oldSql,
          sql2: newSql,
          dialect,
          schema_context: schema,
        })
        const data = (res.data ?? {}) as Record<string, any>
        const validationErrors = asArray(data.validation_errors)
        // Undecidable when: call failed, no schema to resolve columns, the engine
        // returned validation errors, or the engine itself flagged the comparison
        // as not decidable (altimate-core@0.5.1 `decidable` field — authoritative,
        // catches semantic abstentions that carry no validation error). Never
        // guess equivalent=true.
        const decided =
          res.success === true &&
          typeof data.equivalent === "boolean" &&
          !res.error &&
          !data.error &&
          validationErrors.length === 0 &&
          data.decidable !== false &&
          !!schema
        if (!decided) return { decided: false }
        // The engine flags column-reorder etc. as `minor` but still sets
        // equivalent:true for a row-changing filter (noting a `semantic` diff).
        // Treat ANY semantic/major/breaking difference as NOT equivalent — a
        // dropped/added row predicate must never be cleared as "safe".
        const diffs = asArray<any>(data.differences)
        const hasMaterialDiff = diffs.some((d) =>
          /^(semantic|major|breaking|critical)$/i.test(String(d?.severity ?? "")),
        )
        const equivalent = data.equivalent === true && !hasMaterialDiff
        return {
          decided: true,
          equivalent,
          differences: diffs.map((d) => d?.description ?? String(d)),
          confidence: bandConfidence(data.confidence),
        }
      } catch {
        return { decided: false }
      }
    },

    async detectPii(sql: string): Promise<{ columns: string[] }> {
      // Text-based PII comes from altimate_core.check (schema.detect_pii is
      // warehouse-based and unavailable in CI). Reuses the memoized check.
      const result = await runCheck(sql)
      return { columns: result.piiColumns ?? [] }
    },
  }
}
