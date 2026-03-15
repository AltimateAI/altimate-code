import { describe, test, expect } from "bun:test"
import {
  trainingId,
  trainingTags,
  isTrainingBlock,
  trainingKind,
  parseTrainingMeta,
  embedTrainingMeta,
  TrainingKind,
  TRAINING_TAG,
  TRAINING_ID_PREFIX,
  type TrainingBlockMeta,
} from "../../src/altimate/training/types"

describe("trainingId", () => {
  test("creates id with prefix, kind, and name", () => {
    expect(trainingId("pattern", "staging-model")).toBe("training/pattern/staging-model")
  })

  test("works for all kinds", () => {
    expect(trainingId("rule", "no-float")).toBe("training/rule/no-float")
    expect(trainingId("glossary", "arr")).toBe("training/glossary/arr")
    expect(trainingId("standard", "sql-style")).toBe("training/standard/sql-style")
  })
})

describe("trainingTags", () => {
  test("includes training tag and kind", () => {
    const tags = trainingTags("pattern")
    expect(tags).toContain(TRAINING_TAG)
    expect(tags).toContain("pattern")
  })

  test("includes extra tags", () => {
    const tags = trainingTags("rule", ["sql", "naming"])
    expect(tags).toContain(TRAINING_TAG)
    expect(tags).toContain("rule")
    expect(tags).toContain("sql")
    expect(tags).toContain("naming")
  })

  test("returns at least 2 tags with no extras", () => {
    expect(trainingTags("glossary").length).toBe(2)
  })
})

describe("isTrainingBlock", () => {
  test("returns true when training tag present", () => {
    expect(isTrainingBlock({ tags: ["training", "pattern"] })).toBe(true)
  })

  test("returns false when training tag missing", () => {
    expect(isTrainingBlock({ tags: ["pattern", "sql"] })).toBe(false)
  })

  test("returns false for empty tags", () => {
    expect(isTrainingBlock({ tags: [] })).toBe(false)
  })
})

describe("trainingKind", () => {
  test("extracts pattern kind", () => {
    expect(trainingKind({ tags: ["training", "pattern"] })).toBe("pattern")
  })

  test("extracts rule kind", () => {
    expect(trainingKind({ tags: ["training", "rule"] })).toBe("rule")
  })

  test("extracts glossary kind", () => {
    expect(trainingKind({ tags: ["training", "glossary"] })).toBe("glossary")
  })

  test("extracts standard kind", () => {
    expect(trainingKind({ tags: ["training", "standard"] })).toBe("standard")
  })

  test("returns undefined for non-training tags", () => {
    expect(trainingKind({ tags: ["sql", "warehouse"] })).toBeUndefined()
  })

  test("returns first valid kind if multiple present", () => {
    const kind = trainingKind({ tags: ["training", "rule", "pattern"] })
    expect(kind).toBeDefined()
    expect(["rule", "pattern"]).toContain(kind!)
  })
})

describe("TrainingKind schema", () => {
  test("accepts valid kinds", () => {
    expect(TrainingKind.safeParse("pattern").success).toBe(true)
    expect(TrainingKind.safeParse("rule").success).toBe(true)
    expect(TrainingKind.safeParse("glossary").success).toBe(true)
    expect(TrainingKind.safeParse("standard").success).toBe(true)
  })

  test("rejects invalid kinds", () => {
    expect(TrainingKind.safeParse("invalid").success).toBe(false)
    expect(TrainingKind.safeParse("").success).toBe(false)
    expect(TrainingKind.safeParse(123).success).toBe(false)
  })
})

describe("embedTrainingMeta", () => {
  test("embeds meta as HTML comment block", () => {
    const meta: TrainingBlockMeta = {
      kind: "pattern",
      source: "stg_orders.sql",
      applied: 3,
    }
    const result = embedTrainingMeta("Pattern content here", meta)
    expect(result).toContain("<!-- training")
    expect(result).toContain("kind: pattern")
    expect(result).toContain("source: stg_orders.sql")
    expect(result).toContain("applied: 3")
    expect(result).toContain("-->")
    expect(result).toContain("Pattern content here")
  })

  test("omits source when undefined", () => {
    const meta: TrainingBlockMeta = {
      kind: "rule",
      applied: 0,
    }
    const result = embedTrainingMeta("Rule content", meta)
    expect(result).not.toContain("source:")
  })

  test("replaces existing meta block", () => {
    const existing = "<!-- training\nkind: pattern\napplied: 1\n-->\nOld content"
    const meta: TrainingBlockMeta = {
      kind: "pattern",
      applied: 5,
    }
    const result = embedTrainingMeta(existing, meta)
    expect(result).toContain("applied: 5")
    expect(result).not.toContain("applied: 1")
    // Content should be preserved
    expect(result).toContain("Old content")
  })
})

describe("parseTrainingMeta", () => {
  test("parses embedded meta", () => {
    const content = "<!-- training\nkind: pattern\nsource: stg_orders.sql\napplied: 3\n-->\nPattern content"
    const meta = parseTrainingMeta(content)
    expect(meta).toBeDefined()
    expect(meta!.kind).toBe("pattern")
    expect(meta!.source).toBe("stg_orders.sql")
    expect(meta!.applied).toBe(3)
  })

  test("returns undefined for content without meta", () => {
    expect(parseTrainingMeta("Just plain content")).toBeUndefined()
  })

  test("handles meta without source", () => {
    const content = "<!-- training\nkind: rule\napplied: 0\n-->\nRule"
    const meta = parseTrainingMeta(content)
    expect(meta).toBeDefined()
    expect(meta!.kind).toBe("rule")
    expect(meta!.source).toBeUndefined()
  })

  test("roundtrips through embed/parse", () => {
    const original: TrainingBlockMeta = {
      kind: "standard",
      source: "docs/style-guide.md",
      applied: 7,
    }
    const embedded = embedTrainingMeta("Test content", original)
    const parsed = parseTrainingMeta(embedded)
    expect(parsed).toBeDefined()
    expect(parsed!.kind).toBe(original.kind)
    expect(parsed!.source).toBe(original.source)
    expect(parsed!.applied).toBe(original.applied)
  })
})

describe("constants", () => {
  test("TRAINING_TAG is 'training'", () => {
    expect(TRAINING_TAG).toBe("training")
  })

  test("TRAINING_ID_PREFIX is 'training'", () => {
    expect(TRAINING_ID_PREFIX).toBe("training")
  })
})
