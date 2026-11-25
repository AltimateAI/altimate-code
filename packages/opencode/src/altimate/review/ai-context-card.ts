// altimate_change - new file: dbt manifest context card for the AI lane
//
// On by default in `reviewPullRequest` (the `contextCard` switch; opt out with
// `ai: { contextCard: false }` or `ALTIMATE_REVIEW_AI_CONTEXT_CARD=0`; needs a manifest): each file
// sent to the AI reviewer carries a short block of manifest facts the diff does
// not show — materialization and keys, parents and children, declared columns
// and their tests, sibling models; for a macro, its callers and adapter variants.
import type { AiReviewFile } from "./ai-review"

/** Manifest facts about one model, snapshot or seed. */
export interface ModelCard {
  resourceType: string
  materialized?: string
  uniqueKey?: string
  incrementalStrategy?: string
  partitionBy?: string
  clusterBy?: string
  contractEnforced: boolean
  /** Direct parents: model/seed/snapshot names and `source.table` names. */
  parents: string[]
  /** Direct downstream models. */
  children: string[]
  exposures: string[]
  /** Columns declared in yml (at most 25), with the tests attached to each. */
  columns: Array<{ name: string; dataType?: string; tests: string[] }>
  /** Other models in the same directory sharing at least one direct parent (at most 8). */
  siblings: string[]
}

/** Manifest facts about one macro. */
export interface MacroCard {
  /** The macro the card describes (resolved by file path in the project, else by name). */
  name: string
  /** Models whose `depends_on.macros` include it (at most 10, models changed in the PR first). */
  callers: string[]
  /** The dispatcher `<base>` and other `<adapter>__<base>` macros, as `name (path)`. */
  variants: string[]
}

export type ContextCard = { name: string; model: ModelCard } | { name: string; macro: MacroCard }

/** Characters of context card per file and per model call. */
export const CARD_MAX_CHARS = 600
export const CARD_BATCH_MAX_CHARS = 6_000

/** List caps tried in order until the card fits. */
const LIST_CAPS = [25, 10, 6, 3, 1, 0]

function list(items: string[], cap: number): string {
  const shown = items.slice(0, cap).join(", ")
  const more = items.length - Math.min(cap, items.length)
  return more > 0 ? `${shown}${shown ? " " : ""}+${more} more` : shown
}

function renderOne(card: ContextCard, cap: number): string[] {
  if ("macro" in card) {
    const m = card.macro
    const lines = [`macro \`${m.name}\``]
    if (m.callers.length) lines.push(`callers: ${list(m.callers, cap)}`)
    if (m.variants.length) lines.push(`variants: ${list(m.variants, cap)}`)
    return lines
  }
  const m = card.model
  const attrs = [
    m.materialized && `materialized: ${m.materialized}`,
    m.incrementalStrategy && `strategy: ${m.incrementalStrategy}`,
    m.uniqueKey && `unique_key: ${m.uniqueKey}`,
    m.partitionBy && `partition_by: ${m.partitionBy}`,
    m.clusterBy && `cluster_by: ${m.clusterBy}`,
    m.contractEnforced && "contract: enforced",
  ].filter(Boolean)
  const lines = [`${m.resourceType} \`${card.name}\`${attrs.length ? `: ${attrs.join("; ")}` : ""}`]
  if (m.parents.length) lines.push(`parents: ${list(m.parents, cap)}`)
  if (m.children.length) lines.push(`children: ${list(m.children, cap)}`)
  if (m.exposures.length) lines.push(`exposures: ${list(m.exposures, cap)}`)
  if (m.columns.length) {
    const cols = m.columns.map((c) => `${c.name}${c.dataType ? ` ${c.dataType}` : ""}${c.tests.length ? ` [${c.tests.join(", ")}]` : ""}`)
    lines.push(`columns: ${list(cols, cap)}`)
  }
  if (m.siblings.length) lines.push(`siblings: ${list(m.siblings, cap)}`)
  return lines
}

/** The card text for one file (one or more cards), at most `maxChars`; lists shrink to `+N more` first. */
export function renderContextCard(card: ContextCard | ContextCard[], maxChars = CARD_MAX_CHARS): string {
  const cards = Array.isArray(card) ? card : [card]
  if (!cards.length) return ""
  let text = ""
  for (const cap of LIST_CAPS) {
    text = cards.flatMap((c) => renderOne(c, cap)).join("\n")
    if (text.length <= maxChars) return text
  }
  return text.slice(0, maxChars - 1) + "…"
}

const MODEL_KINDS = new Set(["model_sql", "python_model", "snapshot", "seed"])
const DECLARING_KINDS = new Set(["schema_yml", "source_yml", "test"])

interface CardSource {
  modelCard?(name: string, opts?: { path?: string }): Promise<ModelCard | undefined>
  patchedModels?(path: string): Promise<string[]>
  macroCard?(name: string, opts?: { path?: string; changedModels?: string[] }): Promise<MacroCard | undefined>
  graphParents?(paths: string[]): Promise<Array<{ kind: string; name: string }>>
}

/**
 * Attach a rendered card to each file the manifest knows: models, snapshots and
 * seeds get their own card, macros theirs, a yml or singular test the cards of the
 * models it declares (`patch_path`) or tests (at most 3). Files without facts get none. Never throws.
 */
export async function attachContextCards(files: AiReviewFile[], runner: CardSource): Promise<void> {
  const changedModels = files.filter((f) => MODEL_KINDS.has(f.kind ?? "model_sql")).map((f) => f.model)
  const cardsFor = async (f: AiReviewFile): Promise<ContextCard[]> => {
    const kind = f.kind ?? "model_sql"
    if (MODEL_KINDS.has(kind)) {
      const model = await runner.modelCard?.(f.model, { path: f.path })
      return model ? [{ name: f.model, model }] : []
    }
    if (kind === "macro") {
      const macro = await runner.macroCard?.(f.model, { path: f.path, changedModels })
      return macro ? [{ name: macro.name, macro }] : []
    }
    if (!DECLARING_KINDS.has(kind)) return []
    const [declared, parents] = await Promise.all([
      runner.patchedModels?.(f.path) ?? Promise.resolve([]),
      runner.graphParents?.([f.path]) ?? Promise.resolve([]),
    ])
    const tested = (parents ?? []).filter((p) => p.kind === "model").map((p) => p.name)
    const names = [...new Set([...(declared ?? []), ...tested])].slice(0, 3)
    const cards = await Promise.all(names.map(async (name) => ({ name, model: await runner.modelCard?.(name) })))
    return cards.flatMap((c) => (c.model ? [{ name: c.name, model: c.model }] : []))
  }
  await Promise.all(
    files.map(async (f) => {
      const cards = await cardsFor(f).catch(() => [])
      const text = renderContextCard(cards)
      if (text) f.card = text
    }),
  )
}
