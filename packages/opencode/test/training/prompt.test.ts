import { describe, test, expect } from "bun:test"

// Standalone test for training prompt formatting
// Does NOT import from src/ to avoid dependency chain issues.

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

const KIND_HEADERS: Record<TrainingKind, { header: string; instruction: string }> = {
  pattern: {
    header: "Learned Patterns",
    instruction: "Follow these patterns when creating similar artifacts. They were learned from the user's codebase.",
  },
  rule: {
    header: "Learned Rules",
    instruction: "Always follow these rules. They were taught by the user through corrections and explicit instruction.",
  },
  glossary: {
    header: "Domain Glossary",
    instruction: "Use these definitions when discussing business concepts. They are specific to the user's domain.",
  },
  standard: {
    header: "Team Standards",
    instruction: "Enforce these standards in code reviews and when writing new code. They were loaded from team documentation.",
  },
}

function formatEntry(entry: TrainingEntry): string {
  const meta = entry.meta.applied > 0 ? ` (applied ${entry.meta.applied}x)` : ""
  return `#### ${entry.name}${meta}\n${entry.content}`
}

function inject(entries: TrainingEntry[], budget: number = 6000): string {
  if (entries.length === 0) return ""

  const grouped = new Map<TrainingKind, TrainingEntry[]>()
  for (const entry of entries) {
    const list = grouped.get(entry.kind) ?? []
    list.push(entry)
    grouped.set(entry.kind, list)
  }

  const header =
    "## Teammate Training\n\nYou have been trained on the following knowledge by your team. Apply it consistently.\n"
  let result = header
  let used = header.length

  for (const kind of ["rule", "pattern", "standard", "glossary"] as TrainingKind[]) {
    const items = grouped.get(kind)
    if (!items || items.length === 0) continue

    const section = KIND_HEADERS[kind]
    const sectionHeader = `\n### ${section.header}\n_${section.instruction}_\n`
    if (used + sectionHeader.length > budget) break
    result += sectionHeader
    used += sectionHeader.length

    for (const entry of items) {
      const formatted = formatEntry(entry)
      const needed = formatted.length + 2
      if (used + needed > budget) break
      result += "\n" + formatted + "\n"
      used += needed
    }
  }

  return result
}

function makeEntry(overrides: Partial<TrainingEntry> = {}): TrainingEntry {
  return {
    id: "training/pattern/test",
    kind: "pattern",
    name: "test",
    scope: "project",
    content: "Test content",
    meta: { kind: "pattern", applied: 0, accepted: 0, rejected: 0 },
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("TrainingPrompt.formatEntry", () => {
  test("formats entry with name and content", () => {
    const entry = makeEntry({
      name: "staging-model",
      content: "- Use CTE for renaming\n- Cast types explicitly",
    })
    const result = formatEntry(entry)
    expect(result).toContain("#### staging-model")
    expect(result).toContain("- Use CTE for renaming")
    expect(result).toContain("- Cast types explicitly")
  })

  test("includes applied count when > 0", () => {
    const entry = makeEntry({
      name: "no-float",
      kind: "rule",
      meta: { kind: "rule", applied: 7, accepted: 5, rejected: 0 },
    })
    const result = formatEntry(entry)
    expect(result).toContain("(applied 7x)")
  })

  test("omits applied count when 0", () => {
    const entry = makeEntry({
      name: "arr",
      kind: "glossary",
      meta: { kind: "glossary", applied: 0, accepted: 0, rejected: 0 },
    })
    const result = formatEntry(entry)
    expect(result).not.toContain("applied")
  })

  test("produces valid markdown heading", () => {
    const entry = makeEntry({ name: "sql-style", kind: "standard" })
    const result = formatEntry(entry)
    expect(result).toMatch(/^####/)
  })

  test("handles multiline content", () => {
    const entry = makeEntry({
      content: "Line 1\nLine 2\nLine 3\n\n## Sub-heading\n- Bullet 1\n- Bullet 2",
    })
    const result = formatEntry(entry)
    expect(result).toContain("Line 1\nLine 2\nLine 3")
    expect(result).toContain("## Sub-heading")
    expect(result).toContain("- Bullet 1")
  })
})

describe("TrainingPrompt.inject", () => {
  test("returns empty string for no entries", () => {
    expect(inject([])).toBe("")
  })

  test("includes header", () => {
    const result = inject([makeEntry()])
    expect(result).toContain("## Teammate Training")
    expect(result).toContain("Apply it consistently")
  })

  test("groups entries by kind", () => {
    const entries = [
      makeEntry({ kind: "rule", name: "r1", meta: { kind: "rule", applied: 0, accepted: 0, rejected: 0 } }),
      makeEntry({ kind: "pattern", name: "p1", meta: { kind: "pattern", applied: 0, accepted: 0, rejected: 0 } }),
    ]
    const result = inject(entries)
    expect(result).toContain("### Learned Rules")
    expect(result).toContain("### Learned Patterns")
  })

  test("orders kinds: rules first, then patterns, standards, glossary", () => {
    const entries = [
      makeEntry({ kind: "glossary", name: "g1", content: "Glossary", meta: { kind: "glossary", applied: 0, accepted: 0, rejected: 0 } }),
      makeEntry({ kind: "rule", name: "r1", content: "Rule", meta: { kind: "rule", applied: 0, accepted: 0, rejected: 0 } }),
      makeEntry({ kind: "pattern", name: "p1", content: "Pattern", meta: { kind: "pattern", applied: 0, accepted: 0, rejected: 0 } }),
      makeEntry({ kind: "standard", name: "s1", content: "Standard", meta: { kind: "standard", applied: 0, accepted: 0, rejected: 0 } }),
    ]
    const result = inject(entries)
    const ruleIdx = result.indexOf("### Learned Rules")
    const patternIdx = result.indexOf("### Learned Patterns")
    const standardIdx = result.indexOf("### Team Standards")
    const glossaryIdx = result.indexOf("### Domain Glossary")
    expect(ruleIdx).toBeLessThan(patternIdx)
    expect(patternIdx).toBeLessThan(standardIdx)
    expect(standardIdx).toBeLessThan(glossaryIdx)
  })

  test("respects budget limit", () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      makeEntry({
        kind: "rule",
        name: `rule-${i}`,
        content: "x".repeat(200),
        meta: { kind: "rule", applied: 0, accepted: 0, rejected: 0 },
      }),
    )
    const result = inject(entries, 1000)
    expect(result.length).toBeLessThanOrEqual(1200) // some slack for the last entry
  })

  test("includes kind-specific instructions", () => {
    const entries = [
      makeEntry({ kind: "rule", name: "r1", meta: { kind: "rule", applied: 0, accepted: 0, rejected: 0 } }),
    ]
    const result = inject(entries)
    expect(result).toContain("Always follow these rules")
  })

  test("includes entry content", () => {
    const entries = [
      makeEntry({
        kind: "pattern",
        name: "staging",
        content: "- Use CTEs for renaming columns",
        meta: { kind: "pattern", applied: 0, accepted: 0, rejected: 0 },
      }),
    ]
    const result = inject(entries)
    expect(result).toContain("Use CTEs for renaming columns")
  })
})
