// altimate_change start — dbt-factor-helpers: normalize and render the engine's
// factoring proposals (shared logic → one new intermediate model), and build
// the multi-file patch for one.
import path from "path"
import { type Manifest, type NormalizedProof, findModel, formatProof, normalizeProof, unifiedPatch } from "./dbt-mart-helpers"
import { type CostAssessment, type FileEdit, formatCost, mapConsumerSql } from "./dbt-optimize-helpers"

export interface FactorConsumer {
  model: string
  consumer_sql?: string
  proof: NormalizedProof
}

export interface FactorProposal {
  index: number
  /** New model name, always `int_`-prefixed. */
  name: string
  new_model_sql: string
  schema_yml?: string
  consumers: FactorConsumer[]
  occurrences?: number
  savings?: unknown
  storage?: unknown
  raw: Record<string, unknown>
}

/** Normalize the engine's proposals; field names are tolerated in the forms
 *  the plan used (`new_model_name`/`name`, `new_model_sql`/`sql`, …). */
export function normalizeFactorProposals(list: unknown): FactorProposal[] {
  const arr = Array.isArray(list) ? (list as Record<string, unknown>[]) : []
  return arr.map((p, i) => {
    const base = String(p.new_model_name ?? p.name ?? `shared_${i + 1}`)
    const consumers = Array.isArray(p.consumers) ? (p.consumers as Record<string, unknown>[]) : []
    return {
      index: i + 1,
      name: base.startsWith("int_") ? base : `int_${base}`,
      new_model_sql: String(p.new_model_sql ?? p.sql ?? ""),
      schema_yml: typeof (p.schema_yml ?? p.yml) === "string" ? String(p.schema_yml ?? p.yml) : undefined,
      consumers: consumers.map((c) => ({
        model: String(c.model ?? c.name ?? "?"),
        consumer_sql: typeof (c.consumer_sql ?? c.after_sql) === "string" ? String(c.consumer_sql ?? c.after_sql) : undefined,
        proof: normalizeProof(c.proof),
      })),
      occurrences: typeof p.occurrences === "number" ? p.occurrences : consumers.length,
      savings: p.savings ?? p.savings_estimate,
      storage: p.storage ?? p.storage_tradeoff,
      raw: p,
    }
  })
}

const show = (v: unknown) => (v === undefined || v === null ? "(not stated)" : typeof v === "string" ? v : JSON.stringify(v))

export function formatFactorProposal(p: FactorProposal): string[] {
  const lines = [`#${p.index} ${p.name} — shared by ${p.consumers.length} consumer(s) (${p.occurrences ?? "?"} occurrence(s))`]
  lines.push(`    savings: ${show(p.savings)}`)
  lines.push(`    storage trade-off: ${show(p.storage)}`)
  const cost = formatCost(p.raw.cost as CostAssessment | undefined)
  if (cost) lines.push(`    cost: ${cost}`)
  for (const c of p.consumers) lines.push(`    ${c.model}: ${formatProof(c.proof)}`)
  return lines
}

export type FactorPlan =
  | { ok: true; edits: FileEdit[]; patch: string }
  | { ok: false; reason: string; patch: string }

/**
 * The multi-file patch: `models/intermediate/<name>.sql`, its yml contract,
 * and each consumer edited to read it. Refuses when any consumer proof is
 * refuted, or when a consumer's Jinja cannot be mapped back (the compiled
 * patch is still returned for reading).
 */
export function buildFactorPlan(input: {
  manifest: Manifest
  proposal: FactorProposal
  readRaw: (file: string) => string | undefined
}): FactorPlan {
  const { manifest, proposal: p } = input
  const dir = "models/intermediate"
  const newFile = path.join(dir, `${p.name}.sql`)
  const ymlFile = path.join(dir, `${p.name}.yml`)
  const compiledPatch =
    unifiedPatch(newFile + " (compiled)", "", p.new_model_sql) +
    p.consumers.map((c) => unifiedPatch(`${c.model} (compiled)`, "", c.consumer_sql ?? "")).join("")
  const refuted = p.consumers.filter((c) => c.proof.status === "refuted")
  if (refuted.length)
    return {
      ok: false,
      reason: `consumer proof REFUTED for ${refuted.map((c) => c.model).join(", ")} — factoring would change their results`,
      patch: compiledPatch,
    }
  const invalid = p.consumers.filter((c) => c.proof.status === "invalid_sql")
  if (invalid.length)
    return {
      ok: false,
      reason: `generated SQL does not bind for ${invalid.map((c) => c.model).join(", ")} — ${invalid[0].proof.reason ?? "invalid SQL"}`,
      patch: compiledPatch,
    }
  const edits: FileEdit[] = []
  let newSql: string | undefined
  for (const c of p.consumers) {
    const node = findModel(manifest, c.model)
    if (!node?.original_file_path) return { ok: false, reason: `consumer ${c.model} not in the manifest`, patch: compiledPatch }
    if (!c.consumer_sql) return { ok: false, reason: `no edited SQL for consumer ${c.model}`, patch: compiledPatch }
    const raw = input.readRaw(node.original_file_path) ?? node.raw_code ?? ""
    const m = mapConsumerSql({ model: node, raw, consumerSql: c.consumer_sql, newModelName: p.name })
    if (!m.ok) return { ok: false, reason: `${c.model}: ${m.reason}`, patch: compiledPatch }
    newSql ??= m.newModelSql(p.new_model_sql)
    edits.push({ file: node.original_file_path, before: raw, after: m.sql })
  }
  if (!newSql) return { ok: false, reason: "proposal has no consumers", patch: compiledPatch }
  const yml =
    p.schema_yml ??
    `version: 2\n\nmodels:\n  - name: ${p.name}\n    description: "Shared logic factored out of ${p.consumers.map((c) => c.model).join(", ")}."\n`
  edits.unshift({ file: newFile, before: "", after: newSql }, { file: ymlFile, before: "", after: yml })
  return { ok: true, edits, patch: edits.map((e) => unifiedPatch(e.file, e.before, e.after)).join("") }
}
// altimate_change end
