import { describe, test, expect } from "bun:test"
import {
  extractEquivalenceErrors,
  formatEquivalence,
} from "../../src/altimate/tools/altimate-core-equivalence"

describe("extractEquivalenceErrors", () => {
  test("returns undefined when validation_errors is absent", () => {
    expect(extractEquivalenceErrors({})).toBeUndefined()
  })

  test("returns undefined for empty validation_errors array", () => {
    expect(extractEquivalenceErrors({ validation_errors: [] })).toBeUndefined()
  })

  test("joins string errors with semicolons", () => {
    const data = { validation_errors: ["column X not found", "table Y not found"] }
    expect(extractEquivalenceErrors(data)).toBe("column X not found; table Y not found")
  })

  test("extracts .message from object errors", () => {
    const data = {
      validation_errors: [
        { message: "unresolved reference to column 'id'" },
        { message: "ambiguous column name" },
      ],
    }
    expect(extractEquivalenceErrors(data)).toBe(
      "unresolved reference to column 'id'; ambiguous column name",
    )
  })

  test("falls back to String(e) for non-string primitive errors", () => {
    const data = { validation_errors: [42] }
    // 42 → typeof 42 !== "string" → e.message (undefined) ?? String(42) = "42"
    expect(extractEquivalenceErrors(data)).toBe("42")
  })

  test("handles null entries in validation_errors without crashing", () => {
    // Previously crashed: null.message throws TypeError before ?? can evaluate
    // Fixed with optional chaining: e?.message ?? String(e)
    const data = { validation_errors: [null, "real error"] }
    expect(extractEquivalenceErrors(data)).toBe("null; real error")
  })

  test("filters out falsy messages", () => {
    const data = { validation_errors: [{ message: "" }, { message: "real error" }] }
    // Empty string is filtered by .filter(Boolean)
    expect(extractEquivalenceErrors(data)).toBe("real error")
  })

  test("returns undefined when all messages are empty", () => {
    const data = { validation_errors: [{ message: "" }] }
    expect(extractEquivalenceErrors(data)).toBeUndefined()
  })
})

describe("formatEquivalence", () => {
  test("shows error message when data.error is present (short-circuits)", () => {
    const data = { error: "Schema not found", equivalent: true }
    // error takes priority over equivalent
    expect(formatEquivalence(data)).toBe("Error: Schema not found")
  })

  test("shows equivalent message when queries match", () => {
    const data = { equivalent: true }
    expect(formatEquivalence(data)).toBe("Queries are semantically equivalent.")
  })

  test("shows different message when queries don't match", () => {
    const data = { equivalent: false }
    expect(formatEquivalence(data)).toContain("Queries produce different results.")
  })

  test("decidable:false is reported as UNDECIDABLE, even when equivalent is true", () => {
    const data = { equivalent: true, decidable: false }
    const output = formatEquivalence(data)
    expect(output).toContain("UNDECIDABLE")
    expect(output).not.toContain("Queries are semantically equivalent.")
  })

  test("lists differences with description field", () => {
    const data = {
      equivalent: false,
      differences: [
        { description: "WHERE clause differs" },
        { description: "Column order differs" },
      ],
    }
    const output = formatEquivalence(data)
    expect(output).toContain("Differences:")
    expect(output).toContain("  - WHERE clause differs")
    expect(output).toContain("  - Column order differs")
  })

  test("falls back to raw value when description is absent", () => {
    const data = {
      equivalent: false,
      differences: ["plain string difference"],
    }
    const output = formatEquivalence(data)
    expect(output).toContain("  - plain string difference")
  })

  test("shows confidence level", () => {
    const data = { equivalent: true, confidence: "high" }
    expect(formatEquivalence(data)).toContain("Confidence: high")
  })

  test("omits confidence when not present", () => {
    const data = { equivalent: true }
    expect(formatEquivalence(data)).not.toContain("Confidence")
  })
})
