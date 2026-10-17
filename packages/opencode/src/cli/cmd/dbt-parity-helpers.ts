// altimate_change start — dbt-parity-helpers: run the engine's ParityPlan over an
// executor and judge it. Pure apart from the injected executor, so the whole
// pass/fail logic is testable with a fake warehouse.

// ---------------------------------------------------------------------------
// Types — the engine's `ParityPlan`
// ---------------------------------------------------------------------------

export interface ParitySqlTask {
  id: string
  table_side?: string
  sql: string
  expected_shape?: string
}

export interface ParityPlanTask {
  kind: string
  task: ParitySqlTask
  pass_when: string
}

export interface ParityPlan {
  model?: string
  before?: string
  after?: string
  grain_keys?: string[]
  grain_source?: string
  columns?: string[]
  tasks: ParityPlanTask[]
  notes?: string[]
}

export function normalizeParityPlan(data: unknown): ParityPlan {
  const d = (data ?? {}) as Record<string, unknown>
  const tasks = Array.isArray(d.tasks) ? (d.tasks as ParityPlanTask[]).filter((t) => t?.task?.sql) : []
  return { ...(d as Partial<ParityPlan>), tasks }
}

/** Task kinds whose result rows are ROW VALUES, not aggregates. They can carry
 *  PII, so they only run with an explicit `--sample-rows` (data-parity skill rule). */
export const ROW_VALUE_KINDS = new Set(["except_sample", "join_diff"])

export interface QueryResult {
  columns: string[]
  rows: (string | null)[][]
}

export type Executor = (sql: string, task: ParityPlanTask) => Promise<QueryResult>

export type TaskStatus = "pass" | "fail" | "skipped" | "error" | "unevaluated"

export interface TaskOutcome {
  id: string
  kind: string
  pass_when: string
  status: TaskStatus
  /** First row as column → value, for single-row tasks. */
  values?: Record<string, string | null>
  /** Row-set tasks: the rows (only when sampling was allowed). */
  columns?: string[]
  rows?: (string | null)[][]
  row_count?: number
  detail?: string
}

export type ParityVerdict = "match" | "mismatch" | "inconclusive"

export interface ParityResult {
  verdict: ParityVerdict
  plan: ParityPlan
  outcomes: TaskOutcome[]
  summary: ParitySummary
}

export interface ParitySummary {
  row_count_before?: number
  row_count_after?: number
  row_delta?: number
  duplicated_keys_before?: number
  duplicated_keys_after?: number
  except_before_minus_after?: number
  except_after_minus_before?: number
  column_match_rates?: Array<{ column: string; matches: number; joined_rows: number; rate: number }>
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function toNum(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined || v.trim() === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Run every task. Row-value tasks are skipped unless `sampleRows > 0`; a
 *  failing query is an `error` outcome, never a silent pass. */
export async function runParityPlan(
  plan: ParityPlan,
  exec: Executor,
  opts: { sampleRows: number },
): Promise<ParityResult> {
  const outcomes: TaskOutcome[] = []
  for (const t of plan.tasks) {
    const base = { id: t.task.id, kind: t.kind, pass_when: t.pass_when }
    if (ROW_VALUE_KINDS.has(t.kind) && opts.sampleRows <= 0) {
      outcomes.push({
        ...base,
        status: "skipped",
        detail: "returns row values — pass --sample-rows N to run it (rows may contain PII)",
      })
      continue
    }
    try {
      const r = await exec(t.task.sql, t)
      const first = r.rows[0]
      const values = first ? Object.fromEntries(r.columns.map((c, i) => [c.toLowerCase(), first[i] ?? null])) : {}
      const rowSet = t.task.expected_shape === "RowSet" || ROW_VALUE_KINDS.has(t.kind)
      outcomes.push({
        ...base,
        status: "unevaluated",
        values: rowSet ? undefined : values,
        columns: rowSet ? r.columns : undefined,
        rows: rowSet ? r.rows.slice(0, Math.max(opts.sampleRows, 0)) : undefined,
        row_count: r.rows.length,
      })
    } catch (e) {
      outcomes.push({ ...base, status: "error", detail: e instanceof Error ? e.message : String(e) })
    }
  }
  evaluate(outcomes)
  return { verdict: verdictOf(outcomes), plan, outcomes, summary: summarize(outcomes) }
}

/** Resolve a name in a `pass_when` expression: the task's own column first,
 *  then another task's id (its first column). */
function resolve(name: string, own: TaskOutcome, all: TaskOutcome[]): number | undefined {
  const n = name.trim().toLowerCase()
  if (/^-?\d+(\.\d+)?$/.test(n)) return Number(n)
  if (own.values && n in own.values) return toNum(own.values[n])
  const other = all.find((o) => o.id.toLowerCase() === n && o.values)
  if (other?.values) return toNum(Object.values(other.values)[0])
  return undefined
}

/** Judge each executed outcome against its `pass_when`. The forms the engine
 *  emits are `a = b`, `no rows`, and `every <column>__matches = joined_rows`;
 *  anything else stays `unevaluated`, which makes the verdict inconclusive. */
export function evaluate(outcomes: TaskOutcome[]): void {
  for (const o of outcomes) {
    if (o.status !== "unevaluated") continue
    const rule = o.pass_when.trim()
    if (/^no rows$/i.test(rule)) {
      o.status = (o.row_count ?? 0) === 0 ? "pass" : "fail"
      continue
    }
    const every = rule.match(/^every\s+<column>__matches\s*=\s*(\w+)$/i)
    if (every) {
      const total = toNum(o.values?.[every[1].toLowerCase()])
      const cols = Object.entries(o.values ?? {}).filter(([k]) => k.endsWith("__matches"))
      if (total === undefined || !cols.length) {
        o.detail = `cannot evaluate "${rule}"`
        continue
      }
      o.status = cols.every(([, v]) => toNum(v) === total) ? "pass" : "fail"
      continue
    }
    const eq = rule.match(/^([\w.]+)\s*(=|==)\s*([\w.]+)$/)
    if (eq) {
      const a = resolve(eq[1], o, outcomes)
      const b = resolve(eq[3], o, outcomes)
      if (a === undefined || b === undefined) {
        o.detail = `cannot evaluate "${rule}" (missing value)`
        continue
      }
      o.status = a === b ? "pass" : "fail"
      continue
    }
    o.detail = `unrecognized pass condition "${rule}"`
  }
}

export function verdictOf(outcomes: TaskOutcome[]): ParityVerdict {
  if (outcomes.some((o) => o.status === "fail")) return "mismatch"
  if (outcomes.some((o) => o.status === "error" || o.status === "unevaluated")) return "inconclusive"
  if (!outcomes.some((o) => o.status === "pass")) return "inconclusive"
  return "match"
}

function first(outcomes: TaskOutcome[], id: string): number | undefined {
  const o = outcomes.find((x) => x.id === id)
  return o?.values ? toNum(Object.values(o.values)[0]) : undefined
}

export function summarize(outcomes: TaskOutcome[]): ParitySummary {
  const s: ParitySummary = {
    row_count_before: first(outcomes, "row_count_before"),
    row_count_after: first(outcomes, "row_count_after"),
    duplicated_keys_before: first(outcomes, "grain_duplicates_before"),
    duplicated_keys_after: first(outcomes, "grain_duplicates_after"),
    except_before_minus_after: first(outcomes, "except_count_before_minus_after"),
    except_after_minus_before: first(outcomes, "except_count_after_minus_before"),
  }
  if (s.row_count_before !== undefined && s.row_count_after !== undefined)
    s.row_delta = s.row_count_after - s.row_count_before
  const rates = outcomes.find((o) => o.kind === "column_match_rates")
  if (rates?.values) {
    const joined = toNum(rates.values["joined_rows"]) ?? 0
    s.column_match_rates = Object.entries(rates.values)
      .filter(([k]) => k.endsWith("__matches"))
      .map(([k, v]) => {
        const matches = toNum(v) ?? 0
        return { column: k.slice(0, -"__matches".length), matches, joined_rows: joined, rate: joined ? matches / joined : 1 }
      })
  }
  return s
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const n = (v: number | undefined) => (v === undefined ? "?" : v.toLocaleString("en-US"))

export function formatParityText(r: ParityResult, opts: { sampleRows: number }): string {
  const { plan, summary: s } = r
  const lines: string[] = []
  lines.push(`dbt-parity ${plan.model ?? "?"}: ${plan.before ?? "?"} (before) vs ${plan.after ?? "?"} (after)`)
  lines.push(
    `Grain: ${plan.grain_keys?.length ? plan.grain_keys.join(", ") : "(none)"} — source: ${plan.grain_source ?? "?"}`,
  )
  lines.push("")
  lines.push(
    `Rows: before ${n(s.row_count_before)}, after ${n(s.row_count_after)}` +
      (s.row_delta !== undefined ? `, delta ${s.row_delta >= 0 ? "+" : ""}${n(s.row_delta)}` : ""),
  )
  if (s.duplicated_keys_before !== undefined || s.duplicated_keys_after !== undefined)
    lines.push(`Duplicated grain keys: before ${n(s.duplicated_keys_before)}, after ${n(s.duplicated_keys_after)}`)
  lines.push(
    `EXCEPT: before−after ${n(s.except_before_minus_after)}, after−before ${n(s.except_after_minus_before)}`,
  )
  if (s.column_match_rates?.length) {
    lines.push("Column match rates (rows joined on the grain):")
    for (const c of s.column_match_rates)
      lines.push(`  ${c.column}: ${(c.rate * 100).toFixed(4)}% (${n(c.matches)}/${n(c.joined_rows)})`)
  }
  lines.push("")
  lines.push("Checks:")
  for (const o of r.outcomes) {
    const extra = o.detail ? ` — ${o.detail}` : ""
    lines.push(`  ${o.status.toUpperCase().padEnd(11)} ${o.id} (pass when: ${o.pass_when})${extra}`)
    if (o.rows?.length) {
      lines.push(`    ${o.columns?.join(" | ") ?? ""}`)
      for (const row of o.rows) lines.push(`    ${row.map((v) => (v === null ? "NULL" : v)).join(" | ")}`)
    }
  }
  if (opts.sampleRows <= 0 && r.outcomes.some((o) => o.status === "skipped"))
    lines.push("  (row samples not fetched: they may contain PII — opt in with --sample-rows N)")
  if (plan.notes?.length) {
    lines.push("")
    for (const note of plan.notes) lines.push(`Note: ${note}`)
  }
  lines.push("")
  lines.push(
    r.verdict === "match"
      ? "PARITY: MATCH"
      : r.verdict === "mismatch"
        ? "PARITY: MISMATCH"
        : "PARITY: INCONCLUSIVE (a check errored or could not be evaluated — not a pass)",
  )
  return lines.join("\n")
}
// altimate_change end
