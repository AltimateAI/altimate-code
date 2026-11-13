import { makeFinding, type Finding } from "./finding"
import type { ChangedFile } from "./diff-filter"
import { capabilityFor } from "./adapter-capabilities"

/**
 * dbt incremental, microbatch and snapshot semantics. These rules follow
 * dbt-core behavior, which is the same on every adapter; where the outcome
 * depends on the adapter (concurrent commits, atomic table replace) they read
 * the capability table and stay silent for adapters it doesn't cover.
 *
 * Config comes from the manifest (dbt_project.yml + yml + inline, merged by
 * dbt) overlaid by the head's inline `{{ config() }}` (inline wins in dbt, and
 * the manifest may predate the PR). Change detection compares the inline
 * config of the two sides.
 *
 * All findings are advisory (`dbt-semantics` evidence → catalog origin).
 */

// ---------------------------------------------------------------------------
// Inline config parsing
// ---------------------------------------------------------------------------

/** Index of the bracket closing the one at `open`, skipping quoted strings. */
function closing(s: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
  const stack: string[] = []
  let quote: string | null = null
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === "\\") i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (pairs[c]) stack.push(pairs[c])
    else if (c === stack.at(-1)) {
      stack.pop()
      if (!stack.length) return i
    }
  }
  return -1
}

/** Split on commas at nesting depth 0, outside quotes. */
function topLevelSplit(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === "\\") i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if ("([{".includes(c)) depth++
    else if (")]}".includes(c)) depth--
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}

/** `key → raw value text` from every `{{ config(...) }}` in the SQL. */
export function inlineConfig(sql: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!sql) return out
  for (const m of sql.matchAll(/\{\{-?\s*config\s*\(/g)) {
    const open = m.index! + m[0].length - 1
    const close = closing(sql, open)
    if (close < 0) continue
    for (const part of topLevelSplit(sql.slice(open + 1, close))) {
      const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*?)\s*$/.exec(part)
      if (kv) out[kv[1]] = kv[2]
    }
  }
  return out
}

/** Value text normalized for comparison: no whitespace, one quote style, lowercase. */
const norm = (v: string | undefined) => v?.replace(/\s+/g, "").replace(/"/g, "'").toLowerCase()
const unquote = (v: string) => v.trim().replace(/^['"]|['"]$/g, "")

function asList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase())
  const s = String(v).trim()
  if (s.startsWith("[")) return [...s.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1].toLowerCase())
  return [unquote(s).toLowerCase()]
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v
  if (typeof v === "string") {
    const s = unquote(v).toLowerCase()
    if (s === "true") return true
    if (s === "false") return false
  }
  return undefined
}

export interface ModelSemantics {
  materialized?: string
  strategy?: string
  uniqueKey?: string[]
  onSchemaChange?: string
  concurrentBatches?: boolean
  contractEnforced?: boolean
  onTableExists?: string
}

/** Effective config: manifest `config` overlaid by the inline `{{ config() }}`. */
export function modelSemantics(inline: Record<string, string>, manifest?: Record<string, unknown>): ModelSemantics {
  const m = manifest ?? {}
  const str = (k: string) => (inline[k] !== undefined ? unquote(inline[k]).toLowerCase() : typeof m[k] === "string" ? (m[k] as string).toLowerCase() : undefined)
  const contractInline = inline.contract !== undefined ? /['"]?enforced['"]?\s*:\s*true/i.test(inline.contract) : undefined
  const contractManifest = (m.contract as { enforced?: boolean } | undefined)?.enforced
  return {
    materialized: str("materialized"),
    strategy: str("incremental_strategy"),
    uniqueKey: asList(inline.unique_key ?? m.unique_key),
    onSchemaChange: str("on_schema_change"),
    concurrentBatches: asBool(inline.concurrent_batches ?? m.concurrent_batches),
    contractEnforced: contractInline ?? contractManifest,
    onTableExists: str("on_table_exists"),
  }
}

/** The SQL with config blocks, comments and whitespace removed: what the model computes. */
export function modelBody(sql: string): string {
  let s = sql.replace(/\{#[\s\S]*?#\}/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ")
  for (;;) {
    const m = /\{\{-?\s*config\s*\(/.exec(s)
    if (!m) break
    const close = closing(s, m.index + m[0].length - 1)
    const end = close < 0 ? -1 : s.indexOf("}}", close)
    if (end < 0) break
    s = s.slice(0, m.index) + s.slice(end + 2)
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase()
}

/** Columns compared to a `var()` in the model: the slice one run processes (tenant, region…). */
export function varScopedColumns(sql: string): string[] {
  const out = new Set<string>()
  const re = /(?:\b[A-Za-z_][\w]*\.)?\b([A-Za-z_][\w]*)\s*(?:=|\bin\b)\s*\(?\s*['"]?\{\{\s*var\s*\(/gi
  for (const m of modelBody(sql).matchAll(re)) out.add(m[1].toLowerCase())
  return [...out]
}

const PLAN_RE = /full[- _]?refresh|backfill|forward[- ]only|rebuild|re-?run (the )?history|history (is|stays|will)/i

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface IncrementalInput {
  file: ChangedFile
  model: string
  newSql: string
  oldSql?: string
  /** The model's `config` from the manifest, when it is there. */
  manifestConfig?: Record<string, unknown>
  /** Added diff lines (raw). */
  added: string[]
  dialect: string
  dialectKnown: boolean
  /** PR title + description; empty outside a PR run. */
  prText: string
  /** Exposures or downstream models depend on this model. */
  hasConsumers: boolean
  /** Output columns added/removed by the change (lazy: needs column lineage). */
  columnDelta: () => Promise<{ added: string[]; removed: string[] }>
}

function finding(input: { file: ChangedFile; model: string }, rule: string, severity: Finding["severity"], category: Finding["category"], title: string, body: string): Finding {
  return makeFinding({
    severity,
    category,
    title: `${input.model}: ${title}`,
    body,
    file: input.file.path,
    model: input.model,
    confidence: "high",
    evidence: { tool: "dbt-semantics", result: { rule } },
    ruleKey: `${category}:${rule}`,
  })
}

const ticks = (xs: string[]) => xs.map((x) => `\`${x}\``).join(", ")

export async function incrementalFindings(input: IncrementalInput): Promise<Finding[]> {
  const inlineNew = inlineConfig(input.newSql)
  const inlineOld = inlineConfig(input.oldSql)
  const cfg = modelSemantics(inlineNew, input.manifestConfig)
  const isNew = input.file.status === "added"
  const configChanged = (k: string) => !isNew && norm(inlineOld[k]) !== norm(inlineNew[k])
  const addedText = input.added.join("\n")
  const out: Finding[] = []
  const cap = input.dialectKnown ? capabilityFor(input.dialect) : undefined

  if (cfg.materialized === "incremental") {
    // Logic changed under an existing incremental table, with no stated plan for history.
    if (!isNew && input.oldSql && modelBody(input.oldSql) !== modelBody(input.newSql) && !PLAN_RE.test(input.prText))
      out.push(
        finding(input, "incremental-logic-no-refresh", "warning", "materialization", "incremental logic changed without a full-refresh or backfill plan",
          "Rows already in the incremental table keep the old logic; only new runs use the new one. " +
            "Say in the PR how history is handled: `--full-refresh` on deploy, a backfill of the affected range, or that the change is forward-only."),
      )

    if (configChanged("partition_by") && inlineOld.partition_by !== undefined)
      out.push(
        finding(input, "incremental-partition-change", "warning", "materialization", "`partition_by` changed on an incremental model",
          "The existing table keeps its old partitioning; incremental runs don't rebuild it. Run `--full-refresh` on deploy."),
      )

    if (cfg.onSchemaChange === "fail" && !isNew) {
      const { added, removed } = await input.columnDelta()
      if (added.length || removed.length) {
        const what = [added.length ? `adds ${ticks(added)}` : "", removed.length ? `removes ${ticks(removed)}` : ""].filter(Boolean).join(" and ")
        out.push(
          finding(input, "on-schema-change-fail", "warning", "materialization", "`on_schema_change='fail'` with changed columns",
            `This change ${what}, and \`on_schema_change='fail'\` stops the first incremental run after merge. ` +
              "Run `--full-refresh` on deploy, or use `append_new_columns` / `sync_all_columns`."),
        )
      }
    }

    // Microbatch on an adapter whose concurrent commits to one table conflict.
    if (cfg.strategy === "microbatch" && cap?.concurrentCommitsConflict && cfg.concurrentBatches !== false &&
        (isNew || configChanged("incremental_strategy") || configChanged("concurrent_batches")))
      out.push(
        finding(input, "microbatch-concurrent-commits", "warning", "materialization", "microbatch batches may commit concurrently",
          `On ${input.dialect}, concurrent commits to one table conflict (Iceberg/Delta optimistic concurrency), so parallel batches ` +
            "and overlapping backfills fail with commit errors. Set `concurrent_batches=false`."),
      )

    // A per-slice run (filtered by a var) whose key doesn't contain the slice column.
    if ((cfg.strategy === "delete+insert" || cfg.strategy === "merge") && cfg.uniqueKey?.length &&
        (isNew || /unique_key|incremental_strategy|var\s*\(/i.test(addedText))) {
      const missing = varScopedColumns(input.newSql).filter((c) => !cfg.uniqueKey!.includes(c))
      if (missing.length)
        out.push(
          finding(input, "unique-key-missing-slice-column", "warning", "dedup", `\`unique_key\` doesn't include ${ticks(missing)}`,
            `Each run processes the slice selected by ${ticks(missing)} (a \`var()\` filter), but \`unique_key\` is ${ticks(cfg.uniqueKey)}. ` +
              (cfg.strategy === "delete+insert"
                ? "A run for one slice deletes other slices' rows that share a key. "
                : "A run for one slice overwrites other slices' rows that share a key. ") +
              `Add ${ticks(missing)} to \`unique_key\`.`),
        )
    }
  }

  // Non-atomic table rebuild on an adapter that runs create-then-insert or drop-then-create.
  const gap =
    cfg.materialized === "table" && cap?.contractTableReplaceAtomic === false
      ? cfg.onTableExists === "drop"
        ? "drops the table and then builds it, so it doesn't exist during each build"
        : cfg.onTableExists === "replace" && cfg.contractEnforced
          ? "runs `create or replace table` and then `insert` as two statements (enforced contract), so readers see an empty table during each build"
          : undefined
      : undefined
  if (gap && (isNew || /contract|on_table_exists|materialized/i.test(addedText)))
    out.push(
      finding(input, "non-atomic-table-replace", input.hasConsumers ? "warning" : "suggestion", "materialization", "table is unavailable while it rebuilds",
        `On ${input.dialect}, \`on_table_exists='${cfg.onTableExists}'\` ${gap}.` +
          (input.hasConsumers ? " This model has declared consumers; schedule them after the build, or use `on_table_exists='rename'`." : "")),
    )

  return out
}

/** Snapshot definitions: a changed `check_cols`/strategy or SELECT on an existing snapshot. */
export function snapshotFindings(input: { file: ChangedFile; model: string; newSql: string; oldSql?: string; prText: string }): Finding[] {
  if (input.file.status === "added" || !input.oldSql) return []
  const before = inlineConfig(input.oldSql)
  const after = inlineConfig(input.newSql)
  const out: Finding[] = []
  const changed = ["check_cols", "strategy"].filter((k) => before[k] !== undefined && norm(before[k]) !== norm(after[k]))
  if (changed.length)
    out.push(
      finding(input, "snapshot-tracking-change", "warning", "materialization", `snapshot ${changed.map((k) => `\`${k}\``).join(" and ")} changed`,
        "Changing what an existing snapshot compares can version every row on the next run (a column new to the snapshot compares " +
          "NULL with its value), recording history that never happened. Check on a copy first, or start a new snapshot table."),
    )
  else if (modelBody(input.oldSql) !== modelBody(input.newSql) && !PLAN_RE.test(input.prText))
    out.push(
      finding(input, "snapshot-logic-no-plan", "warning", "materialization", "snapshot query changed without a plan for history",
        "Rows already captured keep the old query's values; the next run versions every row whose values the new query computes differently. " +
          "Say in the PR how history is handled (backfill, a new snapshot, or accepted as forward-only)."),
    )
  return out
}
