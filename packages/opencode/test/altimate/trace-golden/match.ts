// Structural diff between a normalized "actual" trace and a committed golden.
// Produces a minimal, path-based diff — not a blob dump — so a broken golden
// tells a reviewer exactly which span(s) changed and how.
//
// Partial-order matching: `logToolCall` appends spans on completion (not
// start) and both Batch (`Promise.all`, batch.ts:158) and the parallel
// session/prompt.ts resolver dispatch tool calls concurrently, so two
// structurally-identical runs can legitimately resolve a race between
// concurrent siblings to different array positions / different ordinal ids.
// normalize.ts's `rank` field is derived structurally from each span's own
// `kind` (all `"tool"`-kind siblings under a parent always share one rank,
// since their completion order is never trustworthy; every other kind gets
// a real, unique rank from its genuinely synchronous array order) — not
// from timing. `rank` tells us which sibling groups are safe to diff 1:1 by
// id (rank-unique — a real, reproducible order) vs. which are genuinely
// concurrent (same rank, size > 1 on either side) and must be compared as
// an unordered multiset of subtrees instead.
import { stableStringify, type NormalizedSpan, type NormalizedTrace } from "./normalize"

export type DiffKind = "added" | "removed" | "changed"

export interface Diff {
  kind: DiffKind
  /** Dotted/bracketed path, e.g. `spans[2].status` or `spans[5]` (whole span added/removed). */
  path: string
  /** Present for "removed" and "changed". */
  expected?: unknown
  /** Present for "added" and "changed". */
  actual?: unknown
}

export interface MatchResult {
  readonly pass: boolean
  readonly diffs: Diff[]
  /** Human-readable report; empty string when pass is true. */
  format(): string
}

/** Compares two normalized traces and returns a pass/fail result plus a minimal diff list. */
export function match(golden: NormalizedTrace, actual: NormalizedTrace): MatchResult {
  const diffs: Diff[] = []

  diffScalar(diffs, "version", golden.version, actual.version)
  diffScalar(diffs, "sessionId", golden.sessionId, actual.sessionId)
  diffObject(diffs, "metadata", golden.metadata as Record<string, unknown>, actual.metadata as Record<string, unknown>)
  diffObject(diffs, "summary", golden.summary as Record<string, unknown>, actual.summary as Record<string, unknown>)
  diffSpans(diffs, golden.spans, actual.spans)

  const pass = diffs.length === 0
  return {
    pass,
    diffs,
    format: () => (pass ? "" : formatDiffs(diffs)),
  }
}

/** parentId ("<root>" for top-level spans) → rank → sibling spans, in the order they appear in the (already DFS-sorted) input. */
function groupByParentAndRank(spans: NormalizedSpan[]): Map<string, Map<number, NormalizedSpan[]>> {
  const byParent = new Map<string, Map<number, NormalizedSpan[]>>()
  for (const span of spans) {
    const parentKey = span.parentId ?? "<root>"
    let byRank = byParent.get(parentKey)
    if (!byRank) {
      byRank = new Map()
      byParent.set(parentKey, byRank)
    }
    const bucket = byRank.get(span.rank)
    if (bucket) bucket.push(span)
    else byRank.set(span.rank, [span])
  }
  return byParent
}

/**
 * Canonical signature of a span's subtree, ignoring the run-local ordinal
 * (`id`/`parentId`) and the grouping key (`rank`) that got it here — only
 * the span's own content and its children's own canonical signatures
 * contribute. Two spans with the same signature are behaviorally
 * indistinguishable regardless of which ordinal each run happened to
 * assign them.
 */
function canonicalSignature(span: NormalizedSpan, childrenByParentId: Map<string, NormalizedSpan[]>): string {
  const { id, parentId, rank, ...own } = span
  const children = childrenByParentId.get(id) ?? []
  const childSigs = canonicalChildSignatures(children, childrenByParentId)
  return stableStringify({ own, children: childSigs })
}

/**
 * Signs a span's children rank-aware: children are grouped by their own
 * `rank`, groups are emitted in ascending-rank order (preserving the real,
 * reproducible order normalize.ts assigned to non-concurrent siblings), and
 * only the signatures WITHIN a tied-rank (size > 1) group are sorted —
 * because that's the only case where two runs may have assigned physically
 * different ordinals to behaviorally-interchangeable concurrent spans.
 *
 * An indiscriminate sort of ALL descendant signatures (the prior behavior)
 * erased a real order whenever an ordered child sequence was reached through
 * a concurrent ancestor: two accepted raw traces where ordered child
 * sequences changed ownership between concurrent parents normalized to
 * different bytes in normalize.ts, yet this function's old `.sort()` still
 * signed them identically, so `match()` returned `pass: true` on a real
 * topology change. See codex-tracegolden-code-review.md finding #4 (half B).
 */
function canonicalChildSignatures(
  children: NormalizedSpan[],
  childrenByParentId: Map<string, NormalizedSpan[]>,
): string[] {
  const byRank = new Map<number, NormalizedSpan[]>()
  for (const child of children) {
    const bucket = byRank.get(child.rank)
    if (bucket) bucket.push(child)
    else byRank.set(child.rank, [child])
  }
  const out: string[] = []
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const group = byRank.get(rank)!
    const sigs = group.map((c) => canonicalSignature(c, childrenByParentId))
    out.push(...(group.length > 1 ? sigs.sort() : sigs))
  }
  return out
}


function buildChildrenByParentId(spans: NormalizedSpan[]): Map<string, NormalizedSpan[]> {
  const byParentId = new Map<string, NormalizedSpan[]>()
  for (const span of spans) {
    if (span.parentId === null) continue
    const bucket = byParentId.get(span.parentId)
    if (bucket) bucket.push(span)
    else byParentId.set(span.parentId, [span])
  }
  return byParentId
}

/**
 * Compares a rank-tied sibling group (genuinely concurrent — size > 1 on
 * either side) as an unordered multiset of subtree signatures, rather than
 * pairing by id. Matches are removed from both pools; whatever's left is a
 * real diff, reported against the group rather than a specific (arbitrary)
 * id pairing.
 */
function diffConcurrentGroup(
  diffs: Diff[],
  parentKey: string,
  rank: number,
  golden: NormalizedSpan[],
  actual: NormalizedSpan[],
  goldenChildren: Map<string, NormalizedSpan[]>,
  actualChildren: Map<string, NormalizedSpan[]>,
) {
  const goldenSigs = golden.map((span) => ({ span, sig: canonicalSignature(span, goldenChildren) }))
  const actualPool = actual.map((span) => ({ span, sig: canonicalSignature(span, actualChildren) }))

  const unmatchedGolden: typeof goldenSigs = []
  for (const g of goldenSigs) {
    const idx = actualPool.findIndex((a) => a.sig === g.sig)
    if (idx >= 0) actualPool.splice(idx, 1)
    else unmatchedGolden.push(g)
  }

  const groupPath = `spans[parent=${parentKey}][concurrent-rank=${rank}]`
  for (const g of unmatchedGolden) {
    diffs.push({ kind: "removed", path: `${groupPath}.${g.span.id}`, expected: g.span })
  }
  for (const a of actualPool) {
    diffs.push({ kind: "added", path: `${groupPath}.${a.span.id}`, actual: a.span })
  }
}

function diffSpans(diffs: Diff[], goldenSpans: NormalizedSpan[], actualSpans: NormalizedSpan[]) {
  const goldenChildren = buildChildrenByParentId(goldenSpans)
  const actualChildren = buildChildrenByParentId(actualSpans)

  const goldenGroups = groupByParentAndRank(goldenSpans)
  const actualGroups = groupByParentAndRank(actualSpans)
  const parentKeys = new Set([...goldenGroups.keys(), ...actualGroups.keys()])

  for (const parentKey of [...parentKeys].sort()) {
    const goldenByRank = goldenGroups.get(parentKey) ?? new Map<number, NormalizedSpan[]>()
    const actualByRank = actualGroups.get(parentKey) ?? new Map<number, NormalizedSpan[]>()
    const ranks = new Set([...goldenByRank.keys(), ...actualByRank.keys()])

    for (const rank of [...ranks].sort((a, b) => a - b)) {
      const goldenGroup = goldenByRank.get(rank) ?? []
      const actualGroup = actualByRank.get(rank) ?? []

      if (goldenGroup.length <= 1 && actualGroup.length <= 1) {
        // Rank-unique on both sides — a real, reproducible order. Diff 1:1 by id for a precise,
        // field-level report (and to catch e.g. a singleton span silently changing identity).
        const g = goldenGroup[0]
        const a = actualGroup[0]
        if (g && !a) {
          diffs.push({ kind: "removed", path: `spans[${g.id}]`, expected: g })
        } else if (!g && a) {
          diffs.push({ kind: "added", path: `spans[${a.id}]`, actual: a })
        } else if (g && a) {
          diffObject(diffs, `spans[${g.id}]`, g as unknown as Record<string, unknown>, a as unknown as Record<string, unknown>)
        }
        continue
      }

      // Genuinely concurrent on at least one side — never trust id pairing here.
      diffConcurrentGroup(diffs, parentKey, rank, goldenGroup, actualGroup, goldenChildren, actualChildren)
    }
  }

  // Sanity check: every span id must be unique within its own trace. A duplicate means
  // normalize.ts's DFS-ordinal invariant broke — a bug in this file's assumptions, not a
  // real golden mismatch — so fail loudly rather than silently under/over-report diffs.
  if (new Set(goldenSpans.map((s) => s.id)).size !== goldenSpans.length) {
    throw new Error("match: duplicate span id in golden trace — normalize.ts invariant violated")
  }
  if (new Set(actualSpans.map((s) => s.id)).size !== actualSpans.length) {
    throw new Error("match: duplicate span id in actual trace — normalize.ts invariant violated")
  }
}

function diffObject(diffs: Diff[], basePath: string, golden: Record<string, unknown>, actual: Record<string, unknown>) {
  const keys = new Set([...Object.keys(golden), ...Object.keys(actual)])
  for (const key of [...keys].sort()) {
    diffValue(diffs, `${basePath}.${key}`, golden[key], actual[key])
  }
}

function diffValue(diffs: Diff[], path: string, expected: unknown, actual: unknown) {
  if (deepEqual(expected, actual)) return

  if (isPlainObject(expected) && isPlainObject(actual)) {
    diffObject(diffs, path, expected as Record<string, unknown>, actual as Record<string, unknown>)
    return
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    diffArray(diffs, path, expected, actual)
    return
  }
  diffs.push({ kind: "changed", path, expected, actual })
}

function diffArray(diffs: Diff[], basePath: string, expected: unknown[], actual: unknown[]) {
  const max = Math.max(expected.length, actual.length)
  if (expected.length !== actual.length) {
    diffs.push({ kind: "changed", path: `${basePath}.length`, expected: expected.length, actual: actual.length })
  }
  for (let i = 0; i < max; i++) {
    if (i >= expected.length) {
      diffs.push({ kind: "added", path: `${basePath}[${i}]`, actual: actual[i] })
      continue
    }
    if (i >= actual.length) {
      diffs.push({ kind: "removed", path: `${basePath}[${i}]`, expected: expected[i] })
      continue
    }
    diffValue(diffs, `${basePath}[${i}]`, expected[i], actual[i])
  }
}

function diffScalar(diffs: Diff[], path: string, expected: unknown, actual: unknown) {
  if (!deepEqual(expected, actual)) diffs.push({ kind: "changed", path, expected, actual })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((k) => deepEqual(a[k], b[k]))
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  return false
}

function formatValue(value: unknown): string {
  if (value === undefined) return "<undefined>"
  const json = JSON.stringify(value)
  if (json === undefined) return String(value)
  return json.length > 120 ? `${json.slice(0, 117)}...` : json
}

/** Renders diffs as a compact, reviewable report — one line per conflict, sorted by path. */
export function formatDiffs(diffs: Diff[]): string {
  const sorted = [...diffs].sort((a, b) => a.path.localeCompare(b.path))
  const lines = sorted.map((d) => {
    switch (d.kind) {
      case "added":
        return `  + ${d.path} = ${formatValue(d.actual)}`
      case "removed":
        return `  - ${d.path} = ${formatValue(d.expected)}`
      case "changed":
        return `  ~ ${d.path}: ${formatValue(d.expected)} → ${formatValue(d.actual)}`
    }
  })
  return [`trace-golden mismatch: ${diffs.length} diff(s)`, ...lines].join("\n")
}
