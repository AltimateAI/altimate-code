import { describe, test, expect } from "bun:test"
import {
  extractSemanticsErrors,
  formatSemantics,
} from "../../src/altimate/tools/altimate-core-semantics"

describe("extractSemanticsErrors", () => {
  test("returns undefined when validation_errors is absent", () => {
    expect(extractSemanticsErrors({})).toBeUndefined()
  })

  test("returns undefined for empty validation_errors array", () => {
    expect(extractSemanticsErrors({ validation_errors: [] })).toBeUndefined()
  })

  test("joins string errors with semicolons", () => {
    const data = { validation_errors: ["missing table reference", "ambiguous column"] }
    expect(extractSemanticsErrors(data)).toBe("missing table reference; ambiguous column")
  })

  test("extracts .message from object errors", () => {
    const data = {
      validation_errors: [{ message: "unresolved column 'foo'" }],
    }
    expect(extractSemanticsErrors(data)).toBe("unresolved column 'foo'")
  })

  test("returns undefined when all messages are empty strings", () => {
    const data = { validation_errors: [{ message: "" }] }
    expect(extractSemanticsErrors(data)).toBeUndefined()
  })
})

describe("formatSemantics", () => {
  test("shows error message when data.error is present (short-circuits)", () => {
    const data = { error: "napi-rs internal failure", valid: true }
    // error takes priority over valid
    expect(formatSemantics(data)).toBe("Error: napi-rs internal failure")
  })

  test("shows valid message when data.valid is true", () => {
    const data = { valid: true }
    expect(formatSemantics(data)).toBe("No semantic issues found.")
  })

  test("findings-driven: no findings renders clean regardless of valid flag", () => {
    // `valid` means "plannable", not "clean" — rendering is driven by the
    // findings list. valid:false with no findings surfaces its detail via
    // validation_errors (the error path), not a bare issues header.
    expect(formatSemantics({ valid: false })).toBe("No semantic issues found.")
  })

  test("findings render even when valid is true (cartesian returns valid:true + findings)", () => {
    const data = {
      valid: true,
      findings: [{ severity: "error", rule: "missing_join_condition", message: "Cartesian product detected" }],
    }
    const output = formatSemantics(data)
    expect(output).toContain("[error] missing_join_condition: Cartesian product detected")
  })

  test("lists issues with severity and rule", () => {
    const data = {
      valid: false,
      issues: [
        { severity: "error", rule: "cartesian_product", message: "Unfiltered cross join detected" },
        { severity: "warning", rule: "null_comparison", message: "= NULL should be IS NULL" },
      ],
    }
    const output = formatSemantics(data)
    expect(output).toContain("[error] cartesian_product: Unfiltered cross join detected")
    expect(output).toContain("[warning] null_comparison: = NULL should be IS NULL")
  })

  test("defaults severity to 'warning' when absent", () => {
    const data = {
      valid: false,
      issues: [{ type: "implicit_cast", message: "Implicit type cast on join" }],
    }
    const output = formatSemantics(data)
    // severity ?? "warning" → defaults to "warning"
    // rule ?? issue.type → uses type as fallback
    expect(output).toContain("[warning] implicit_cast: Implicit type cast on join")
  })

  test("includes fix suggestions when present", () => {
    const data = {
      valid: false,
      issues: [
        {
          severity: "warning",
          rule: "null_comparison",
          message: "= NULL should be IS NULL",
          suggestion: "Change `WHERE col = NULL` to `WHERE col IS NULL`",
        },
      ],
    }
    const output = formatSemantics(data)
    expect(output).toContain("Fix: Change `WHERE col = NULL` to `WHERE col IS NULL`")
  })

  test("omits fix line when suggestion is absent", () => {
    const data = {
      valid: false,
      issues: [{ severity: "error", rule: "bad_join", message: "Wrong join condition" }],
    }
    const output = formatSemantics(data)
    expect(output).not.toContain("Fix:")
  })
})
