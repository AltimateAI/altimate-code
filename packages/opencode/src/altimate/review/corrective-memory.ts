import z from "zod"

const SCOPE_KEYS = [
  "modelLayer",
  "table",
  "column",
  "operation",
  "warehouse",
  "category",
  "derivedFromKind",
] as const

const ScopeValue = z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string().min(1))

/**
 * Structured, corrective app-memory for dbt-pr-review.
 *
 * P0 is deliberately read-only: seeded config entries may bias generation or
 * suppress advisory findings, but this module does not learn or write entries.
 */
export const MemoryScope = z.object({
  project: ScopeValue.refine((value) => value !== "*", "project must be specific"),
  modelLayer: ScopeValue.optional(),
  table: ScopeValue.optional(),
  column: ScopeValue.optional(),
  operation: ScopeValue.optional(),
  warehouse: ScopeValue.optional(),
  category: ScopeValue.optional(),
  derivedFromKind: ScopeValue.optional(),
})
export type MemoryScope = z.infer<typeof MemoryScope>

export const MemoryEntry = z.object({
  id: z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string().min(1)),
  scope: MemoryScope,
  directive: z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string().min(1)),
  polarity: z.enum(["prefer", "suppress"]),
  provenance: z.object({
    source: z.enum(["human_rule", "accepted_pr", "explicit_dismiss"]),
    committed: z.boolean(),
    supportCount: z.number().int().nonnegative(),
    lastSeen: z.string().optional(),
  }),
})
export type MemoryEntry = z.infer<typeof MemoryEntry>

export interface RankedMemoryEntry {
  entry: MemoryEntry
  score: number
  target: string
}

function fieldMatches(entryValue: string | undefined, queryValue: string | undefined): boolean {
  if (entryValue === undefined) return true
  if (entryValue === "*") return true
  if (queryValue === "*") return true
  return entryValue === queryValue
}

function matches(entry: MemoryEntry, query: Partial<MemoryScope> & { project: string }): boolean {
  if (entry.scope.project !== query.project) return false
  for (const key of SCOPE_KEYS) {
    if (!fieldMatches(entry.scope[key], query[key])) return false
  }
  return true
}

function specificityScore(entry: MemoryEntry, query: Partial<MemoryScope> & { project: string }): number {
  let score = 1 // project matched exactly; it is constant within one isolated query.
  for (const key of SCOPE_KEYS) {
    const value = entry.scope[key]
    if (value === undefined || value === "*") continue
    if (query[key] === "*" || query[key] === value) score++
  }
  return score
}

function materializedTarget(entry: MemoryEntry, query: Partial<MemoryScope> & { project: string }): string {
  return SCOPE_KEYS.map((key) => {
    const entryValue = entry.scope[key]
    const queryValue = query[key]
    const value =
      entryValue && entryValue !== "*"
        ? entryValue
        : queryValue && queryValue !== "*"
          ? queryValue
          : entryValue === "*" || queryValue === "*"
            ? "*"
            : ""
    return `${key}:${value}`
  }).join("|")
}

function outranks(a: RankedMemoryEntry, b: RankedMemoryEntry): boolean {
  if (a.score !== b.score) return a.score > b.score
  const aSupport = a.entry.provenance.supportCount
  const bSupport = b.entry.provenance.supportCount
  if (aSupport !== bSupport) return aSupport > bSupport
  return a.entry.id < b.entry.id
}

/**
 * Pure deterministic retrieval. A wildcard entry field matches any query value;
 * a wildcard query field asks for all values in that dimension. Conflicts for
 * the same materialized target are resolved by specificity, support, then id.
 */
export function getMemory(entries: MemoryEntry[], query: Partial<MemoryScope> & { project: string }): MemoryEntry[] {
  const winners = new Map<string, RankedMemoryEntry>()
  for (const entry of entries) {
    if (!matches(entry, query)) continue
    const ranked = {
      entry,
      score: specificityScore(entry, query),
      target: materializedTarget(entry, query),
    }
    const current = winners.get(ranked.target)
    if (!current || outranks(ranked, current)) winners.set(ranked.target, ranked)
  }
  return [...winners.values()]
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      const supportDelta = b.entry.provenance.supportCount - a.entry.provenance.supportCount
      if (supportDelta !== 0) return supportDelta
      return a.entry.id.localeCompare(b.entry.id)
    })
    .map((ranked) => ranked.entry)
}

export function record(): never {
  throw new Error("corrective memory write path is not implemented in P0")
}
