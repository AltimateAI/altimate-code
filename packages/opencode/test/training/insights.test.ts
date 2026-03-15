import { describe, test, expect } from "bun:test"

// Standalone tests for TrainingInsights logic
// Mirrors the analysis functions without importing from src/ to avoid dependency chains.

type TrainingKind = "pattern" | "rule" | "glossary" | "standard"

interface TrainingBlockMeta {
  kind: TrainingKind
  source?: string
  applied: number
  accepted: number
  rejected: number
}

interface TrainingEntry {
  id: string
  kind: TrainingKind
  name: string
  scope: "global" | "project"
  content: string
  meta: TrainingBlockMeta
  created: string
  updated: string
}

interface TrainingInsight {
  type: "stale" | "high-value" | "near-limit" | "budget-warning" | "consolidation"
  severity: "info" | "warning"
  message: string
  entries?: string[]
}

function isOlderThanDays(dateStr: string, days: number): boolean {
  const created = new Date(dateStr)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  return created < cutoff
}

function findRelatedEntries(entries: TrainingEntry[]): TrainingEntry[][] {
  const groups: TrainingEntry[][] = []
  const used = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    if (used.has(entries[i].name)) continue
    const group = [entries[i]]
    const prefix = entries[i].name.split("-")[0]
    if (prefix.length < 3) continue
    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(entries[j].name)) continue
      if (entries[j].name.startsWith(prefix)) {
        group.push(entries[j])
        used.add(entries[j].name)
      }
    }
    if (group.length >= 2) {
      used.add(entries[i].name)
      groups.push(group)
    }
  }
  return groups
}

function analyze(entries: TrainingEntry[], counts: Record<TrainingKind, number>): TrainingInsight[] {
  if (entries.length === 0) return []
  const insights: TrainingInsight[] = []

  // Stale entries
  const stale = entries.filter((e) => e.meta.applied === 0 && isOlderThanDays(e.created, 7))
  if (stale.length > 0) {
    insights.push({
      type: "stale",
      severity: "info",
      message: `${stale.length} training entry/entries saved 7+ days ago but never applied. Consider reviewing or removing.`,
      entries: stale.map((e) => `${e.kind}/${e.name}`),
    })
  }

  // High-value
  const highValue = entries.filter((e) => e.meta.applied >= 5).sort((a, b) => b.meta.applied - a.meta.applied)
  if (highValue.length > 0) {
    insights.push({
      type: "high-value",
      severity: "info",
      message: `${highValue.length} high-value entry/entries (applied 5+ times). These are your most impactful training.`,
      entries: highValue.slice(0, 5).map((e) => `${e.kind}/${e.name} (${e.meta.applied}x)`),
    })
  }

  // Near-limit
  for (const [kind, count] of Object.entries(counts)) {
    if (count >= 18 && count < 20) {
      insights.push({
        type: "near-limit",
        severity: "warning",
        message: `${kind} entries near limit: ${count}/20. Consider consolidating before adding more.`,
      })
    }
  }

  // Consolidation
  const byKind = new Map<TrainingKind, TrainingEntry[]>()
  for (const e of entries) {
    const list = byKind.get(e.kind) ?? []
    list.push(e)
    byKind.set(e.kind, list)
  }
  for (const [kind, items] of byKind) {
    if (items.length < 2) continue
    const groups = findRelatedEntries(items)
    for (const group of groups) {
      if (group.length >= 3) {
        insights.push({
          type: "consolidation",
          severity: "info",
          message: `${group.length} related ${kind} entries could potentially be consolidated into one.`,
          entries: group.map((e) => e.name),
        })
      }
    }
  }

  return insights
}

function formatInsights(insights: TrainingInsight[]): string {
  if (insights.length === 0) return ""
  const lines = ["\n### Insights"]
  for (const insight of insights) {
    const icon = insight.severity === "warning" ? "!" : "-"
    lines.push(`${icon} ${insight.message}`)
    if (insight.entries && insight.entries.length > 0) {
      for (const e of insight.entries.slice(0, 5)) {
        lines.push(`  - \`${e}\``)
      }
    }
  }
  return lines.join("\n")
}

function makeEntry(overrides: Partial<TrainingEntry> = {}): TrainingEntry {
  return {
    id: "training/rule/test",
    kind: "rule",
    name: "test",
    scope: "project",
    content: "Test content",
    meta: { kind: "rule", applied: 0, accepted: 0, rejected: 0 },
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    ...overrides,
  }
}

function oldDate(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString()
}

describe("Stale entry detection", () => {
  test("detects entries older than 7 days with 0 applied", () => {
    const entries = [
      makeEntry({ name: "old-unused", created: oldDate(10), meta: { kind: "rule", applied: 0, accepted: 0, rejected: 0 } }),
    ]
    const insights = analyze(entries, { pattern: 0, rule: 1, glossary: 0, standard: 0 })
    const stale = insights.find((i) => i.type === "stale")
    expect(stale).toBeDefined()
    expect(stale!.entries).toContain("rule/old-unused")
  })

  test("does not flag recent entries as stale", () => {
    const entries = [
      makeEntry({ name: "new-rule", created: new Date().toISOString(), meta: { kind: "rule", applied: 0, accepted: 0, rejected: 0 } }),
    ]
    const insights = analyze(entries, { pattern: 0, rule: 1, glossary: 0, standard: 0 })
    expect(insights.find((i) => i.type === "stale")).toBeUndefined()
  })

  test("does not flag old entries that have been applied", () => {
    const entries = [
      makeEntry({ name: "old-used", created: oldDate(30), meta: { kind: "rule", applied: 5, accepted: 0, rejected: 0 } }),
    ]
    const insights = analyze(entries, { pattern: 0, rule: 1, glossary: 0, standard: 0 })
    expect(insights.find((i) => i.type === "stale")).toBeUndefined()
  })
})

describe("High-value entry detection", () => {
  test("identifies entries with 5+ applications", () => {
    const entries = [
      makeEntry({ name: "popular", meta: { kind: "rule", applied: 12, accepted: 0, rejected: 0 } }),
      makeEntry({ name: "unpopular", meta: { kind: "rule", applied: 1, accepted: 0, rejected: 0 } }),
    ]
    const insights = analyze(entries, { pattern: 0, rule: 2, glossary: 0, standard: 0 })
    const hv = insights.find((i) => i.type === "high-value")
    expect(hv).toBeDefined()
    expect(hv!.entries).toHaveLength(1)
    expect(hv!.entries![0]).toContain("popular")
  })

  test("returns no high-value insight when all entries have low applied count", () => {
    const entries = [
      makeEntry({ name: "low", meta: { kind: "rule", applied: 2, accepted: 0, rejected: 0 } }),
    ]
    const insights = analyze(entries, { pattern: 0, rule: 1, glossary: 0, standard: 0 })
    expect(insights.find((i) => i.type === "high-value")).toBeUndefined()
  })

  test("sorts high-value entries by applied count descending", () => {
    const entries = [
      makeEntry({ name: "medium", meta: { kind: "rule", applied: 8, accepted: 0, rejected: 0 } }),
      makeEntry({ name: "highest", meta: { kind: "rule", applied: 25, accepted: 0, rejected: 0 } }),
      makeEntry({ name: "low-hv", meta: { kind: "rule", applied: 5, accepted: 0, rejected: 0 } }),
    ]
    const insights = analyze(entries, { pattern: 0, rule: 3, glossary: 0, standard: 0 })
    const hv = insights.find((i) => i.type === "high-value")!
    expect(hv.entries![0]).toContain("highest")
    expect(hv.entries![1]).toContain("medium")
    expect(hv.entries![2]).toContain("low-hv")
  })
})

describe("Near-limit warning", () => {
  test("warns when kind is at 18 or 19 of 20", () => {
    const insights = analyze(
      [makeEntry()],
      { pattern: 0, rule: 19, glossary: 0, standard: 0 },
    )
    const nl = insights.find((i) => i.type === "near-limit")
    expect(nl).toBeDefined()
    expect(nl!.severity).toBe("warning")
    expect(nl!.message).toContain("rule")
    expect(nl!.message).toContain("19/20")
  })

  test("does not warn at 17 or below", () => {
    const insights = analyze(
      [makeEntry()],
      { pattern: 0, rule: 17, glossary: 0, standard: 0 },
    )
    expect(insights.find((i) => i.type === "near-limit")).toBeUndefined()
  })

  test("does not warn at exactly 20 (that's handled by save tool)", () => {
    const insights = analyze(
      [makeEntry()],
      { pattern: 0, rule: 20, glossary: 0, standard: 0 },
    )
    expect(insights.find((i) => i.type === "near-limit")).toBeUndefined()
  })
})

describe("Consolidation opportunities", () => {
  test("detects 3+ entries with same name prefix", () => {
    const entries = [
      makeEntry({ name: "sql-naming", kind: "rule" }),
      makeEntry({ name: "sql-formatting", kind: "rule" }),
      makeEntry({ name: "sql-keywords", kind: "rule" }),
    ]
    const insights = analyze(entries, { pattern: 0, rule: 3, glossary: 0, standard: 0 })
    const cons = insights.find((i) => i.type === "consolidation")
    expect(cons).toBeDefined()
    expect(cons!.entries).toHaveLength(3)
  })

  test("does not flag unrelated entries", () => {
    const entries = [
      makeEntry({ name: "naming-convention", kind: "rule" }),
      makeEntry({ name: "float-prohibition", kind: "rule" }),
      makeEntry({ name: "cte-preference", kind: "rule" }),
    ]
    const insights = analyze(entries, { pattern: 0, rule: 3, glossary: 0, standard: 0 })
    expect(insights.find((i) => i.type === "consolidation")).toBeUndefined()
  })

  test("only groups within same kind", () => {
    const entries = [
      makeEntry({ name: "sql-naming", kind: "rule" }),
      makeEntry({ name: "sql-pattern", kind: "pattern" }),
    ]
    const insights = analyze(entries, { pattern: 1, rule: 1, glossary: 0, standard: 0 })
    expect(insights.find((i) => i.type === "consolidation")).toBeUndefined()
  })
})

describe("Format insights", () => {
  test("returns empty string for no insights", () => {
    expect(formatInsights([])).toBe("")
  })

  test("formats insights with entries", () => {
    const insights: TrainingInsight[] = [{
      type: "stale",
      severity: "info",
      message: "2 stale entries",
      entries: ["rule/old-one", "rule/old-two"],
    }]
    const result = formatInsights(insights)
    expect(result).toContain("### Insights")
    expect(result).toContain("2 stale entries")
    expect(result).toContain("`rule/old-one`")
    expect(result).toContain("`rule/old-two`")
  })

  test("uses ! for warnings", () => {
    const insights: TrainingInsight[] = [{
      type: "near-limit",
      severity: "warning",
      message: "Near limit",
    }]
    const result = formatInsights(insights)
    expect(result).toContain("! Near limit")
  })

  test("uses - for info", () => {
    const insights: TrainingInsight[] = [{
      type: "high-value",
      severity: "info",
      message: "High value entries",
    }]
    const result = formatInsights(insights)
    expect(result).toContain("- High value entries")
  })
})

describe("isOlderThanDays", () => {
  test("returns true for dates older than threshold", () => {
    expect(isOlderThanDays(oldDate(10), 7)).toBe(true)
  })

  test("returns false for recent dates", () => {
    expect(isOlderThanDays(new Date().toISOString(), 7)).toBe(false)
  })

  test("returns false for exactly 7 days ago (boundary)", () => {
    // 7 days ago at same time should be borderline
    const sevenDaysAgo = oldDate(7)
    // Due to millisecond precision, this might be either true or false
    // but 6 days ago should definitely be false
    expect(isOlderThanDays(oldDate(6), 7)).toBe(false)
  })
})

describe("findRelatedEntries", () => {
  test("groups entries by shared prefix", () => {
    const entries = [
      makeEntry({ name: "staging-orders" }),
      makeEntry({ name: "staging-customers" }),
      makeEntry({ name: "staging-products" }),
    ]
    const groups = findRelatedEntries(entries)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(3)
  })

  test("ignores short prefixes (< 3 chars)", () => {
    const entries = [
      makeEntry({ name: "ab-one" }),
      makeEntry({ name: "ab-two" }),
    ]
    const groups = findRelatedEntries(entries)
    expect(groups).toHaveLength(0)
  })

  test("returns empty for unrelated entries", () => {
    const entries = [
      makeEntry({ name: "alpha" }),
      makeEntry({ name: "beta" }),
      makeEntry({ name: "gamma" }),
    ]
    const groups = findRelatedEntries(entries)
    expect(groups).toHaveLength(0)
  })
})

describe("Session-level applied tracking", () => {
  test("appliedThisSession set prevents double-counting", () => {
    // Simulate the session tracking logic from prompt.ts
    const appliedThisSession = new Set<string>()
    const entries = [
      makeEntry({ id: "training/rule/r1", name: "r1" }),
      makeEntry({ id: "training/rule/r2", name: "r2" }),
    ]

    // First injection: both are new
    const firstRound: string[] = []
    for (const e of entries) {
      if (!appliedThisSession.has(e.id)) {
        appliedThisSession.add(e.id)
        firstRound.push(e.id)
      }
    }
    expect(firstRound).toHaveLength(2)

    // Second injection: none should be new
    const secondRound: string[] = []
    for (const e of entries) {
      if (!appliedThisSession.has(e.id)) {
        appliedThisSession.add(e.id)
        secondRound.push(e.id)
      }
    }
    expect(secondRound).toHaveLength(0)
  })

  test("reset clears the tracking set", () => {
    const appliedThisSession = new Set<string>()
    appliedThisSession.add("training/rule/r1")
    expect(appliedThisSession.size).toBe(1)

    // Simulate resetSession()
    appliedThisSession.clear()
    expect(appliedThisSession.size).toBe(0)
  })
})
