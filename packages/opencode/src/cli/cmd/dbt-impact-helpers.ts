// altimate_change start — dbt-impact-helpers: change construction, impact-report
// normalization and rendering for `altimate dbt-impact` and the review lane.

export type ChangeKind = "drop" | "rename" | "retype" | "grain" | "materialization" | "add"
export const CHANGE_KINDS: readonly ChangeKind[] = ["drop", "rename", "retype", "grain", "materialization", "add"]

/** The change handed to `analyzeDbtImpact` as `changeJson` — the engine's
 *  `Change`: `{model, column?, kind, …kind-specific fields}`. `sql` compares
 *  two versions of the model (diff mode). */
export interface DbtChange {
  model: string
  column?: string
  kind: ChangeKind | "sql"
  new_name?: string
  from_type?: string
  to_type?: string
  removed_key?: string
  from?: string
  to?: string
  incremental_strategy?: string
  unique_key?: string[]
  /** `add`: the columns added. */
  columns?: string[]
  base_sql?: string
  head_sql?: string
}

/** `unique_key='a'` or `unique_key=['a', 'b']` from a model's `config()`. */
export function configUniqueKey(raw?: string): string[] {
  const m = raw?.match(/unique_key\s*=\s*(\[[^\]]*\]|['"][^'"]+['"])/)?.[1]
  if (!m) return []
  return [...m.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
}

/** Build a CLI change, enforcing the fields each kind requires. */
export function buildChange(input: {
  model: string
  column?: string
  kind: ChangeKind
  newName?: string
  toType?: string
  fromType?: string
  to?: string
  strategy?: string
  uniqueKey?: string[]
}): DbtChange | { error: string } {
  const c: DbtChange = { model: input.model, kind: input.kind }
  if (input.column) c.column = input.column
  switch (input.kind) {
    case "rename":
      if (!input.newName) return { error: "--kind rename needs --new-name" }
      c.new_name = input.newName
      break
    case "retype":
      if (!input.toType) return { error: "--kind retype needs --to-type" }
      c.to_type = input.toType
      if (input.fromType) c.from_type = input.fromType
      break
    case "grain":
      if (input.column) c.removed_key = input.column
      break
    case "add":
      if (!input.column) return { error: "--kind add needs --column <new column>" }
      delete c.column
      c.columns = [input.column]
      break
    case "materialization":
      if (!input.to) return { error: "--kind materialization needs --to <materialization>" }
      c.to = input.to
      if (input.strategy) c.incremental_strategy = input.strategy
      if (input.uniqueKey?.length) c.unique_key = input.uniqueKey
      break
  }
  return c
}

export type ImpactVerdict = "breaking" | "risky" | "safe" | "unknown"

export interface ImpactEntry {
  hop: number
  /** dbt model, loader, served table, … as the engine names it. */
  node_type: string
  name: string
  verdict: ImpactVerdict
  reason?: string
  columns?: string[]
  [key: string]: unknown
}

/** A reader production can run against a relation that lacks the column. */
export interface SchemaLagFinding {
  reason: string
  verdict: ImpactVerdict
  consumer: string
  column: string
  producer: string
  consumer_jobs?: string[]
  producer_jobs?: string[]
  schedules?: Record<string, string>
  window?: string
  message: string
  fix: string
  alternatives?: string[]
}

export interface ImpactReport {
  change?: unknown
  /** The engine's overall verdict, when it states one. */
  verdict?: ImpactVerdict
  entries: ImpactEntry[]
  notes: string[]
  had_sink_map?: boolean
  loaders?: string[]
  served_tables?: string[]
  /** Loaders are unknown (no sink map, or the model is not in a partial one). */
  sinks_unknown?: boolean
  /** Schema-lag findings (`schema_lag:cross_job`, ...). */
  schema_lag: SchemaLagFinding[]
  /** Schema-lag checks that could not run, and why. */
  schema_lag_skipped: string[]
  /** Reasons behind the verdict. */
  reasons: string[]
  /** SQL diff: the kind it resolved to (`add`, `drop`, ...). */
  resolved_kind?: string
  added_columns?: string[]
}

/** Hop distance for the engine's hop kinds (it reports kinds, not depths). */
const HOP_ORDER: Record<string, number> = { model: 0, dbt_child: 1, dbt_descendant: 2, loader: 3, served_table: 4 }

export const VERDICT_RANK: Record<ImpactVerdict, number> = { breaking: 3, risky: 2, unknown: 1, safe: 0 }

export function normalizeVerdict(v: unknown): ImpactVerdict {
  const s = typeof v === "string" ? v.toLowerCase() : ""
  if (s === "breaking" || s === "break" || s === "broken") return "breaking"
  if (s === "risky" || s === "risk") return "risky"
  if (s === "safe") return "safe"
  return "unknown"
}

/** Normalize the engine's impact report: `hops: [{kind, target, verdict,
 *  evidence, column_level}]`. Grouped forms (`{hop, nodes: [...]}`) and other
 *  field spellings are tolerated; a missing verdict is `unknown`, never `safe`. */
export function normalizeImpactReport(data: unknown): ImpactReport {
  const d = (data ?? {}) as Record<string, unknown>
  const list = (["hops", "impacts", "entries", "value"] as const).map((k) => d[k]).find(Array.isArray) as
    | Record<string, unknown>[]
    | undefined
  const entries: ImpactEntry[] = []
  for (const raw of list ?? []) {
    const group = Array.isArray(raw?.nodes) ? (raw.nodes as Record<string, unknown>[]) : [raw]
    for (const e of group) {
      if (!e || typeof e !== "object") continue
      const nodeType = String(e.node_type ?? e.kind ?? e.type ?? "model")
      const hop =
        typeof e.hop === "number" ? e.hop : typeof raw?.hop === "number" ? raw.hop : (HOP_ORDER[nodeType] ?? 1)
      entries.push({
        ...e,
        hop,
        node_type: nodeType,
        name: String(e.target ?? e.name ?? e.node ?? e.unique_id ?? "?"),
        verdict: normalizeVerdict(e.verdict ?? e.severity),
        reason: [e.evidence, e.reason, e.message].find((x): x is string => typeof x === "string"),
        columns: Array.isArray(e.columns) ? (e.columns as string[]) : undefined,
      })
    }
  }
  const notes = Array.isArray(d.notes) ? (d.notes as string[]) : []
  const summary = (d.summary ?? {}) as Record<string, unknown>
  const had = d.had_sink_map ?? summary.had_sink_map
  const strs = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : undefined)
  const lag = Array.isArray(d.schema_lag) ? (d.schema_lag as Record<string, unknown>[]) : []
  const rk = (d.resolved_kind as { kind?: unknown } | undefined)?.kind
  return {
    change: d.change,
    verdict: d.verdict === undefined ? undefined : normalizeVerdict(d.verdict),
    entries,
    notes,
    had_sink_map: typeof had === "boolean" ? had : undefined,
    loaders: strs(d.loaders),
    served_tables: strs(d.served_tables),
    sinks_unknown: typeof d.sinks_unknown === "boolean" ? d.sinks_unknown : undefined,
    schema_lag: lag.map((f) => ({ ...(f as unknown as SchemaLagFinding), verdict: normalizeVerdict(f.verdict) })),
    schema_lag_skipped: strs(d.schema_lag_skipped) ?? [],
    reasons: strs(d.reasons) ?? [],
    resolved_kind: typeof rk === "string" ? rk : undefined,
    added_columns: strs(d.added_columns),
  }
}

/** True for a hop inside the dbt graph (the changed model or a dbt reader). */
export function isDbtHop(nodeType: string): boolean {
  return /^(model|dbt_)/i.test(nodeType)
}

export function worstVerdict(entries: ImpactEntry[]): ImpactVerdict {
  return entries.reduce<ImpactVerdict>((w, e) => (VERDICT_RANK[e.verdict] > VERDICT_RANK[w] ? e.verdict : w), "safe")
}

/** The engine's overall verdict, raised to the worst hop when a hop is worse. */
export function reportVerdict(r: ImpactReport): ImpactVerdict {
  const hops = worstVerdict(r.entries)
  return r.verdict && VERDICT_RANK[r.verdict] > VERDICT_RANK[hops] ? r.verdict : hops
}

/** True when a BREAKING entry is outside dbt — a loader or a served table.
 *  That is the evidence the review lane needs to block a modified model. */
export function hasExternalBreak(entries: ImpactEntry[]): boolean {
  return entries.some((e) => e.verdict === "breaking" && !isDbtHop(e.node_type))
}

export function formatImpactText(change: DbtChange, r: ImpactReport): string {
  const lines: string[] = []
  const target = change.column ? `${change.model}.${change.column}` : change.model
  const detail = change.new_name ?? change.to_type ?? change.to ?? change.columns?.join(", ")
  lines.push(`dbt-impact: ${change.kind} ${target}${detail ? ` → ${detail}` : ""}`)
  if (r.had_sink_map === false)
    lines.push("Sink map: NO — loaders and served tables beyond dbt are not visible (pass --sinks)")
  if (r.loaders?.length) lines.push(`Loaders: ${r.loaders.join(", ")}`)
  if (r.served_tables?.length) lines.push(`Served tables: ${r.served_tables.join(", ")}`)
  lines.push("")
  if (!r.entries.length) lines.push("No downstream consumers reported.")
  const hops = [...new Set(r.entries.map((e) => e.hop))].sort((a, b) => a - b)
  for (const h of hops) {
    lines.push(`Hop ${h}:`)
    for (const e of r.entries.filter((x) => x.hop === h).sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict])) {
      const cols = e.columns?.length ? ` [${e.columns.join(", ")}]` : ""
      lines.push(`  ${e.verdict.toUpperCase().padEnd(9)} ${e.node_type} ${e.name}${cols}${e.reason ? ` — ${e.reason}` : ""}`)
    }
  }
  if (r.schema_lag.length) {
    lines.push("Schema lag:")
    for (const f of r.schema_lag) {
      lines.push(`  ${f.verdict.toUpperCase().padEnd(9)} ${f.reason} ${f.consumer} reads ${f.producer}.${f.column}`)
      lines.push(`    ${f.message}`)
      lines.push(`    Fix: ${f.fix}`)
    }
  }
  for (const s of r.schema_lag_skipped) lines.push(`Skipped: schema_lag ${s}`)
  for (const n of r.notes) lines.push(`Note: ${n}`)
  lines.push("")
  lines.push(`Overall: ${reportVerdict(r).toUpperCase()}${r.reasons.length ? ` (${r.reasons.join(", ")})` : ""}`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Diff mode
// ---------------------------------------------------------------------------

/** Render a raw model just enough for column-level analysis: drop the config
 *  block and Jinja comments, and spell ref/source as bare relation names.
 *  Returns undefined for anything with other Jinja — it would not parse. */
export function naiveRender(raw: string): string | undefined {
  let s = raw.replace(/\{#[\s\S]*?#\}/g, "").replace(/\{\{-?\s*config\s*\([\s\S]*?\)\s*-?\}\}/, "")
  s = s.replace(/\{\{-?\s*ref\s*\(\s*['"]([^'"]+)['"]\s*\)\s*-?\}\}/g, "$1")
  s = s.replace(/\{\{-?\s*source\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*-?\}\}/g, "$1.$2")
  return /\{\{|\{%/.test(s) ? undefined : s
}

export interface DiffChanges {
  changes: DbtChange[]
  /** Modified models whose change could not be classified, with why. */
  unclassified: Array<{ model: string; reason: string }>
}

/**
 * Turn one changed model file into impact changes:
 * deleted/renamed → `drop` of the model; a changed `materialized=` →
 * `materialization`; otherwise a `sql` change carrying both versions (refs
 * spelled as bare names) for the engine to compare. A modification that
 * cannot be rendered (Jinja beyond ref/source/config) is reported as
 * unclassified, not silently treated as safe.
 */
export function changesForFile(input: {
  model: string
  status: "added" | "modified" | "deleted" | "renamed"
  baseRaw?: string
  headRaw?: string
}): DiffChanges {
  const { model, status, baseRaw, headRaw } = input
  if (status === "added") return { changes: [], unclassified: [] }
  if (status === "deleted" || status === "renamed") return { changes: [{ model, kind: "drop" }], unclassified: [] }
  const changes: DbtChange[] = []
  const mat = (raw?: string) => raw?.match(/materialized\s*=\s*['"](\w+)['"]/)?.[1]
  const [from, to] = [mat(baseRaw), mat(headRaw)]
  if (from !== to && to) {
    const change: DbtChange = { model, kind: "materialization", from, to }
    const strategy = headRaw?.match(/incremental_strategy\s*=\s*['"]([\w+]+)['"]/)?.[1]
    if (strategy) change.incremental_strategy = strategy
    const uniqueKey = configUniqueKey(headRaw)
    if (uniqueKey.length) change.unique_key = uniqueKey
    changes.push(change)
  }
  const b = baseRaw ? naiveRender(baseRaw) : undefined
  const h = headRaw ? naiveRender(headRaw) : undefined
  if (!b || !h) return { changes, unclassified: [{ model, reason: "model uses Jinja beyond ref/source/config" }] }
  if (b.trim() !== h.trim()) changes.push({ model, kind: "sql", base_sql: b, head_sql: h })
  return { changes, unclassified: [] }
}
// altimate_change end
