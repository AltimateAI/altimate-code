// altimate_change start — dbt-optimize-helpers: pure proposal handling for
// `altimate dbt-optimize` — normalization, the apply gate, patch building and
// text rendering. Split from the command so it is testable without yargs.
import path from "path"
import {
  type ManifestNode,
  type NormalizedProof,
  alignRawToCompiled,
  formatProof,
  mapRewriteToRaw,
  normalizeProof,
  relationsToRefs,
  shellQuote,
  unifiedPatch,
} from "./dbt-mart-helpers"
import { type PerfFinding, isMaterializationChange } from "./dbt-perf-helpers"

// ---------------------------------------------------------------------------
// Types — the engine's `RewriteProposal`, loose on purpose (cross-binary contract)
// ---------------------------------------------------------------------------

export interface ModelLevelChange {
  new_model_name?: string
  new_model_sql?: string
  consumer_sql?: string
}

export interface RewriteProposal {
  rule?: string
  source?: string
  before_sql?: string
  after_sql?: string
  ast_diff?: { identical?: boolean; diff_count?: number; diffs?: Array<{ change_type?: string; description?: string }> } | null
  proof?: unknown
  guardrail?: { kind?: string; [key: string]: unknown } | null
  finding_code?: string | null
  applicable?: boolean
  parity_required?: boolean
  model_level?: ModelLevelChange | null
  cost?: CostAssessment | null
  [key: string]: unknown
}

/** The engine's cost gate (`perf::cost_gate`): whether a proven rewrite may be
 *  presented as a performance fix. */
export interface CostAssessment {
  verdict?: "possible_gain" | "unverified" | "break_even" | "readability_only" | string
  perf_claim?: boolean
  plan_identical?: boolean
  extra_writes?: number
  model_seconds?: number
  floor_seconds?: number
  reason?: string
}

/** Proposals the cost gate says are not performance fixes. */
export function notAPerfFix(p: RewriteProposal): boolean {
  return p.cost?.verdict === "readability_only" || p.cost?.verdict === "break_even"
}

export function formatCost(c: CostAssessment | null | undefined): string | undefined {
  if (!c?.verdict) return undefined
  const label: Record<string, string> = {
    possible_gain: "POSSIBLE GAIN",
    unverified: "UNVERIFIED (not a measured win)",
    break_even: "BREAK-EVEN (not proposed as a perf fix)",
    readability_only: "READABILITY ONLY (same plan; not a perf fix)",
  }
  return `${label[c.verdict] ?? c.verdict.toUpperCase()}${c.reason ? ` — ${c.reason}` : ""}`
}

export interface NormalizedProposal extends RewriteProposal {
  index: number
  proofNormalized: NormalizedProof
}

export function normalizeProposals(raw: unknown): NormalizedProposal[] {
  const list = Array.isArray(raw) ? (raw as RewriteProposal[]) : []
  return list.map((p, i) => ({ ...(p ?? {}), index: i + 1, proofNormalized: normalizeProof(p?.proof) }))
}

/** Perf findings that belong to `model` (the engine names models by name or
 *  unique_id depending on the rule). */
export function findingsForModel(findings: PerfFinding[], model: ManifestNode): PerfFinding[] {
  const names = new Set([model.name, model.unique_id].filter(Boolean) as string[])
  return findings.filter((f) => (f.model && names.has(f.model)) || f.related_models?.some((m) => names.has(m)))
}

// ---------------------------------------------------------------------------
// The apply gate
// ---------------------------------------------------------------------------

export type ApplyDecision =
  | { ok: true; proposal: NormalizedProposal; note?: string }
  | { ok: false; reason: string }

/**
 * Pick the proposal `--apply` acts on and decide whether it may be applied.
 *
 * - `--proposal N` names one; otherwise the first PROVEN, applicable proposal,
 *   then (only with `--allow-unproven`) the first undecidable one.
 * - A refuted proposal is never applied — the engine showed it changes results.
 * - An undecidable (or unknown) proof needs `--allow-unproven`, and the parity
 *   command printed afterwards is then the only bar left.
 */
export function chooseProposal(
  proposals: NormalizedProposal[],
  opts: { index?: number; allowUnproven: boolean },
): ApplyDecision {
  if (!proposals.length) return { ok: false, reason: "the engine proposed no rewrites for this model" }
  let p: NormalizedProposal | undefined
  if (opts.index !== undefined) {
    p = proposals.find((x) => x.index === opts.index)
    if (!p) return { ok: false, reason: `no proposal #${opts.index} (there are ${proposals.length})` }
  } else {
    // A performance fix first; a proven readability-only / break-even rewrite
    // is still a safe edit, taken only when nothing better is proven, and the
    // result says it is not a performance fix.
    const isProven = (x: NormalizedProposal) => x.proofNormalized.status === "proven" && x.applicable !== false
    const perf = proposals.filter((x) => !notAPerfFix(x))
    p =
      perf.find(isProven) ??
      (opts.allowUnproven
        ? perf.find((x) => x.proofNormalized.status !== "refuted" && x.applicable !== false)
        : undefined)
    if (!p) {
      const fallback = proposals.find((x) => notAPerfFix(x) && isProven(x))
      if (fallback)
        return {
          ok: true,
          proposal: fallback,
          note: `proposal #${fallback.index} (${fallback.rule ?? "?"}) is ${String(fallback.cost?.verdict).toUpperCase()}: a safe edit, not a performance fix — no proven performance fix was found`,
        }
    }
    if (!p)
      return {
        ok: false,
        reason: proposals.some((x) => x.proofNormalized.status !== "refuted")
          ? "no proposal is PROVEN equivalent; re-run with --allow-unproven to apply an undecidable one (then run the parity check)"
          : "every proposal was REFUTED by the equivalence engine — none is safe to apply",
      }
  }
  if (p.proofNormalized.status === "refuted" || p.applicable === false)
    return { ok: false, reason: `proposal #${p.index} (${p.rule ?? "?"}) is REFUTED — it changes the model's results` }
  if (p.proofNormalized.status !== "proven" && !opts.allowUnproven)
    return {
      ok: false,
      reason: `proposal #${p.index} (${p.rule ?? "?"}) is ${p.proofNormalized.status.toUpperCase()}; pass --allow-unproven to apply it, then run the parity check`,
    }
  return { ok: true, proposal: p }
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

export interface FileEdit {
  /** Project-relative path. */
  file: string
  before: string
  after: string
}

export type PatchPlan =
  | { ok: true; edits: FileEdit[]; patch: string; warnings: string[] }
  | { ok: false; reason: string; patch: string }

/**
 * Build the file edits for a proposal against the model's raw file.
 *
 * Statement-level proposals rewrite the model's compiled SQL; they are mapped
 * back onto the raw file only when {@link mapRewriteToRaw} says that is safe.
 * Model-level proposals add `<new_model_name>.sql` beside the model and edit
 * the model to read it; both go through the same relation → ref mapping, plus
 * a binding for the new model itself.
 *
 * On refusal, `patch` is still the compiled-SQL diff so the reader can apply it
 * by hand.
 */
export function buildPatchPlan(input: { model: ManifestNode; raw: string; proposal: RewriteProposal }): PatchPlan {
  const { model, raw, proposal } = input
  const file = model.original_file_path ?? `${model.name}.sql`
  const compiled = model.compiled_code ?? ""
  const before = proposal.before_sql ?? compiled
  const ml = proposal.model_level
  if (!compiled)
    return {
      ok: false,
      reason: "the manifest has no compiled SQL for this model — run `dbt compile`",
      patch: unifiedPatch(file + " (compiled)", before, proposal.after_sql ?? ""),
    }

  if (ml && ml.new_model_name && ml.new_model_sql && ml.consumer_sql) {
    const compiledPatch =
      unifiedPatch(path.join(path.dirname(file), `${ml.new_model_name}.sql`) + " (compiled)", "", ml.new_model_sql) +
      unifiedPatch(file + " (compiled)", before, ml.consumer_sql)
    const consumer = mapConsumerSql({ model, raw, consumerSql: ml.consumer_sql, newModelName: ml.new_model_name })
    if (!consumer.ok) return { ok: false, reason: consumer.reason, patch: compiledPatch }
    const newSql = consumer.newModelSql(ml.new_model_sql)
    const consumerAfter = consumer.sql
    const newFile = path.join(path.dirname(file), `${ml.new_model_name}.sql`)
    const edits: FileEdit[] = [
      { file: newFile, before: "", after: newSql },
      { file, before: raw, after: consumerAfter },
    ]
    return {
      ok: true,
      edits,
      patch: edits.map((e) => unifiedPatch(e.file, e.before, e.after)).join(""),
      warnings: [
        `${ml.new_model_name} gets no {{ config() }} block and inherits the folder's materialization — set one before building`,
      ],
    }
  }

  const after = proposal.after_sql ?? ""
  const compiledPatch = unifiedPatch(file + " (compiled)", before, after)
  const mapped = mapRewriteToRaw({ raw, compiled, beforeSql: before, afterSql: after })
  if (!mapped.ok) return { ok: false, reason: mapped.reason, patch: compiledPatch }
  const edits = [{ file, before: raw, after: mapped.sql }]
  return { ok: true, edits, patch: unifiedPatch(file, raw, mapped.sql), warnings: mapped.warnings }
}

export type ConsumerMapping =
  | { ok: true; sql: string; newModelSql: (sql: string) => string }
  | { ok: false; reason: string }

/**
 * Map an engine-edited consumer (compiled SQL that now reads a NEW model) back
 * onto the consumer's raw file: its existing relations become their refs, the
 * new model — spelled as a relation in the consumer's schema, or bare —
 * becomes `{{ ref('<new>') }}`, and the consumer's `{{ config() }}` block is
 * kept. `newModelSql` maps the new model's own SQL with the same bindings.
 */
export function mapConsumerSql(input: {
  model: ManifestNode
  raw: string
  consumerSql: string
  newModelName: string
}): ConsumerMapping {
  const { model, raw, consumerSql, newModelName } = input
  const align = alignRawToCompiled(raw, model.compiled_code ?? "")
  if (!align.ok) return align
  const relParts = (model.relation_name ?? "").split(".")
  const newRendered = relParts.length > 1 ? [...relParts.slice(0, -1), `"${newModelName}"`].join(".") : ""
  const newRef = `{{ ref('${newModelName}') }}`
  const bindings = [...align.bindings]
  if (newRendered) bindings.push({ jinja: newRef, rendered: newRendered })
  let consumer = relationsToRefs(consumerSql, bindings)
  consumer = consumer.replace(
    new RegExp(`(\\bfrom|\\bjoin)(\\s+)"?${newModelName}"?(?![\\w."])`, "gi"),
    `$1$2${newRef}`,
  )
  if (!consumer.includes(newRef))
    return { ok: false, reason: `the edited consumer does not visibly read ${newModelName}; refusing to guess where its ref goes` }
  return {
    ok: true,
    sql: (align.header ? align.header + "\n\n" : "") + consumer.trim() + "\n",
    newModelSql: (sql) => relationsToRefs(sql, align.bindings).trim() + "\n",
  }
}

/** The follow-up parity command. `before` is the model's current relation;
 *  `after` is the relation the rebuilt model lands in, which only the caller
 *  knows — a placeholder unless `--parity-after` supplied it. */
export function parityCommand(model: ManifestNode, after?: string): string {
  const before = model.relation_name ?? `<current relation of ${model.name}>`
  return [
    "altimate dbt-parity",
    `--model ${shellQuote(model.name ?? "")}`,
    `--before ${shellQuote(before.replace(/"/g, ""))}`,
    `--after ${after ? shellQuote(after) : "<relation of the rebuilt model, e.g. your dev target>"}`,
  ].join(" ")
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

function guardrailLines(g: RewriteProposal["guardrail"]): string[] {
  if (!g || !g.kind || g.kind === "none") return []
  if (isMaterializationChange(g.kind)) {
    const v = (x: unknown) => (x === undefined || x === null ? "(not stated — verify manually)" : JSON.stringify(x))
    return [
      `    GUARDRAIL MaterializationChange: ${String(g.from ?? "?")} → ${String(g.to ?? "?")}`,
      `      delete scope: ${v(g.delete_scope)}`,
      `      reader requirements: ${v(g.reader_requirements)}`,
    ]
  }
  const rest = Object.entries(g)
    .filter(([k]) => k !== "kind")
    .map(([k, x]) => `${k}=${typeof x === "string" ? x : JSON.stringify(x)}`)
  return [`    guardrail: ${g.kind}${rest.length ? ` (${rest.join(", ")})` : ""}`]
}

const AST_DESC_MAX = 120

/** The AST diff as counts per change type plus a few short examples. The
 *  engine's descriptions can be whole-subtree dumps, so each is cut to one
 *  readable line. */
export function astDiffLines(d: NonNullable<RewriteProposal["ast_diff"]>): string[] {
  const diffs = Array.isArray(d.diffs) ? d.diffs : []
  if (d.identical) return ["    AST diff: identical"]
  const byType = new Map<string, number>()
  for (const x of diffs) byType.set(x.change_type ?? "?", (byType.get(x.change_type ?? "?") ?? 0) + 1)
  const counts = [...byType.entries()].map(([k, v]) => `${v} ${k}`).join(", ")
  const lines = [`    AST diff: ${d.diff_count ?? diffs.length} change(s)${counts ? ` (${counts})` : ""}`]
  for (const x of diffs.slice(0, 3)) {
    const desc = (x.description ?? "").replace(/\s+/g, " ")
    lines.push(`      - ${x.change_type ?? "?"}: ${desc.length > AST_DESC_MAX ? desc.slice(0, AST_DESC_MAX - 1) + "…" : desc}`)
  }
  return lines
}

export function formatProposal(p: NormalizedProposal): string[] {
  const lines: string[] = []
  const tag = p.model_level ? " [model-level]" : ""
  const finding = p.finding_code ? ` for ${p.finding_code}` : ""
  lines.push(`#${p.index} ${p.rule ?? "(unnamed rule)"}${tag} — source: ${p.source ?? "?"}${finding}`)
  lines.push(`    proof: ${formatProof(p.proofNormalized)}`)
  const cost = formatCost(p.cost)
  if (cost) lines.push(`    cost: ${cost}`)
  const d = p.ast_diff
  if (d && typeof d === "object") lines.push(...astDiffLines(d))
  lines.push(...guardrailLines(p.guardrail))
  if (p.parity_required) lines.push("    parity required: yes — only a data parity run can confirm this one")
  if (p.model_level?.new_model_name) lines.push(`    new model: ${p.model_level.new_model_name}`)
  return lines
}
// altimate_change end
