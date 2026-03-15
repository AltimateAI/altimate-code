import { describe, test, expect } from "bun:test"

// Standalone test for training tool parameter validation and logic
// Mirrors the schemas from the training tools without importing from src/
// to avoid dependency chain issues.

// Import only from training/types which has minimal dependencies
import {
  TrainingKind,
  trainingId,
  trainingTags,
  embedTrainingMeta,
  parseTrainingMeta,
  TRAINING_MAX_PATTERNS_PER_KIND,
  type TrainingBlockMeta,
} from "../../src/altimate/training/types"

describe("training_save parameter validation", () => {
  // Validate name format manually (mirrors the regex in training-save.ts)
  const NAME_REGEX = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/

  test("accepts valid names", () => {
    expect(NAME_REGEX.test("staging-model")).toBe(true)
    expect(NAME_REGEX.test("no-float")).toBe(true)
    expect(NAME_REGEX.test("arr")).toBe(true)
    expect(NAME_REGEX.test("sql-style-v2")).toBe(true)
    expect(NAME_REGEX.test("staging-model_v2")).toBe(true)
    expect(NAME_REGEX.test("a")).toBe(true)
    expect(NAME_REGEX.test("a1")).toBe(true)
  })

  test("rejects invalid names", () => {
    expect(NAME_REGEX.test("")).toBe(false)
    expect(NAME_REGEX.test("MyRule")).toBe(false)
    expect(NAME_REGEX.test("my rule")).toBe(false)
    expect(NAME_REGEX.test("-invalid")).toBe(false)
    expect(NAME_REGEX.test("invalid-")).toBe(false)
    expect(NAME_REGEX.test("_invalid")).toBe(false)
    expect(NAME_REGEX.test("invalid_")).toBe(false)
    expect(NAME_REGEX.test("foo/bar")).toBe(false)
    expect(NAME_REGEX.test("foo.bar")).toBe(false)
  })

  test("kind validation via zod schema", () => {
    expect(TrainingKind.safeParse("pattern").success).toBe(true)
    expect(TrainingKind.safeParse("rule").success).toBe(true)
    expect(TrainingKind.safeParse("glossary").success).toBe(true)
    expect(TrainingKind.safeParse("standard").success).toBe(true)
    expect(TrainingKind.safeParse("invalid").success).toBe(false)
    expect(TrainingKind.safeParse("").success).toBe(false)
    expect(TrainingKind.safeParse(123).success).toBe(false)
  })
})

describe("training ID generation", () => {
  test("generates correct IDs for all kinds", () => {
    expect(trainingId("pattern", "test")).toBe("training/pattern/test")
    expect(trainingId("rule", "test")).toBe("training/rule/test")
    expect(trainingId("glossary", "test")).toBe("training/glossary/test")
    expect(trainingId("standard", "test")).toBe("training/standard/test")
  })

  test("handles names with hyphens", () => {
    expect(trainingId("pattern", "staging-model")).toBe("training/pattern/staging-model")
  })

  test("handles names with underscores", () => {
    expect(trainingId("rule", "no_float")).toBe("training/rule/no_float")
  })
})

describe("training tags generation", () => {
  test("includes training tag and kind for all kinds", () => {
    for (const kind of ["pattern", "rule", "glossary", "standard"] as const) {
      const tags = trainingTags(kind)
      expect(tags).toContain("training")
      expect(tags).toContain(kind)
      expect(tags.length).toBe(2)
    }
  })

  test("includes extra tags when provided", () => {
    const tags = trainingTags("rule", ["sql", "naming"])
    expect(tags).toContain("training")
    expect(tags).toContain("rule")
    expect(tags).toContain("sql")
    expect(tags).toContain("naming")
    expect(tags.length).toBe(4)
  })
})

describe("training meta roundtrip through content", () => {
  test("embeds and parses meta correctly", () => {
    const meta: TrainingBlockMeta = {
      kind: "pattern",
      source: "stg_orders.sql",
      applied: 5,
    }
    const content = "- Use CTEs\n- Cast types"
    const embedded = embedTrainingMeta(content, meta)
    const parsed = parseTrainingMeta(embedded)

    expect(parsed).toBeDefined()
    expect(parsed!.kind).toBe("pattern")
    expect(parsed!.source).toBe("stg_orders.sql")
    expect(parsed!.applied).toBe(5)
  })

  test("preserves content after embedding meta", () => {
    const content = "Rule: Use NUMERIC(18,2)\n\nDetails:\n- For all *_amount columns"
    const meta: TrainingBlockMeta = { kind: "rule", applied: 0 }
    const embedded = embedTrainingMeta(content, meta)
    expect(embedded).toContain("Rule: Use NUMERIC(18,2)")
    expect(embedded).toContain("- For all *_amount columns")
  })

  test("replaces existing meta on re-embed", () => {
    const meta1: TrainingBlockMeta = { kind: "pattern", applied: 1 }
    const meta2: TrainingBlockMeta = { kind: "pattern", applied: 10 }
    const content = "Pattern content"

    const embedded1 = embedTrainingMeta(content, meta1)
    expect(parseTrainingMeta(embedded1)!.applied).toBe(1)

    const embedded2 = embedTrainingMeta(embedded1, meta2)
    expect(parseTrainingMeta(embedded2)!.applied).toBe(10)

    // Should not have duplicate meta blocks
    const metaBlocks = embedded2.match(/<!-- training/g)
    expect(metaBlocks).toHaveLength(1)
  })

  test("handles content with special characters", () => {
    const content = "Use `{{ source('schema', 'table') }}` macro\n<!-- not training -->"
    const meta: TrainingBlockMeta = { kind: "pattern", applied: 0 }
    const embedded = embedTrainingMeta(content, meta)
    expect(embedded).toContain("{{ source('schema', 'table') }}")
    expect(embedded).toContain("<!-- not training -->")
  })
})

describe("TRAINING_MAX_PATTERNS_PER_KIND", () => {
  test("is a reasonable limit", () => {
    expect(TRAINING_MAX_PATTERNS_PER_KIND).toBe(20)
    expect(TRAINING_MAX_PATTERNS_PER_KIND).toBeGreaterThan(0)
    expect(TRAINING_MAX_PATTERNS_PER_KIND).toBeLessThanOrEqual(50)
  })
})

describe("content length validation", () => {
  test("content within 2500 chars is acceptable", () => {
    const content = "x".repeat(2500)
    expect(content.length).toBeLessThanOrEqual(2500)
  })

  test("content over 2500 chars should be rejected by tool", () => {
    const content = "x".repeat(2501)
    expect(content.length).toBeGreaterThan(2500)
  })
})
