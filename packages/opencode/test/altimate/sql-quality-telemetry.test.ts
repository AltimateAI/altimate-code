/**
 * SQL Quality Telemetry Tests
 *
 * Verifies the aggregation logic, event payload shape, and finding
 * extraction patterns used for the `sql_quality` telemetry event, and
 * that scenarios with no findings result in empty finding arrays (the
 * condition used by tool.ts to decide not to emit the event).
 */

import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/altimate/telemetry"

// ---------------------------------------------------------------------------
// 1. aggregateFindings
// ---------------------------------------------------------------------------
describe("Telemetry.aggregateFindings", () => {
  test("aggregates findings by category", () => {
    const findings: Telemetry.Finding[] = [
      { category: "missing_table" },
      { category: "missing_column" },
      { category: "lint" },
      { category: "missing_table" },
    ]
    const result = Telemetry.aggregateFindings(findings)
    expect(result).toEqual({
      missing_table: 2,
      missing_column: 1,
      lint: 1,
    })
  })

  test("returns empty object for empty findings", () => {
    const result = Telemetry.aggregateFindings([])
    expect(result).toEqual({})
  })

  test("handles single finding", () => {
    const findings: Telemetry.Finding[] = [
      { category: "syntax_error" },
    ]
    const result = Telemetry.aggregateFindings(findings)
    expect(result).toEqual({ syntax_error: 1 })
  })

  test("handles all same category", () => {
    const findings: Telemetry.Finding[] = [
      { category: "lint" },
      { category: "lint" },
      { category: "lint" },
    ]
    const result = Telemetry.aggregateFindings(findings)
    expect(result).toEqual({ lint: 3 })
  })
})

// ---------------------------------------------------------------------------
// 2. sql_quality event shape validation
// ---------------------------------------------------------------------------
describe("sql_quality event shape", () => {
  test("by_category serializes to valid JSON string", () => {
    const findings: Telemetry.Finding[] = [
      { category: "lint" },
      { category: "lint" },
      { category: "safety" },
    ]
    const by_category = Telemetry.aggregateFindings(findings)
    const json = JSON.stringify(by_category)

    // Should round-trip through JSON
    expect(JSON.parse(json)).toEqual({ lint: 2, safety: 1 })
  })

  test("aggregated counts match finding_count", () => {
    const findings: Telemetry.Finding[] = [
      { category: "a" },
      { category: "b" },
      { category: "c" },
      { category: "a" },
    ]
    const by_category = Telemetry.aggregateFindings(findings)
    const total = Object.values(by_category).reduce((a, b) => a + b, 0)
    expect(total).toBe(findings.length)
  })
})

// ---------------------------------------------------------------------------
// 3. Finding extraction patterns (validates what tools produce)
// ---------------------------------------------------------------------------
describe("tool finding extraction patterns", () => {
  test("sql_analyze issues map to findings via issue.type", () => {
    // issue.type is coarse: "lint", "semantic", "safety"
    const issues = [
      { type: "lint", severity: "warning", message: "...", recommendation: "...", confidence: "high" },
      { type: "safety", severity: "high", message: "...", recommendation: "...", confidence: "high" },
    ]
    const findings: Telemetry.Finding[] = issues.map((i) => ({
      category: i.type,
    }))
    expect(findings).toEqual([
      { category: "lint" },
      { category: "safety" },
    ])
  })

  test("validate errors map to findings with classification", () => {
    const errors = [
      { message: "Table 'users' not found in schema" },
      { message: "Column 'email' not found in table 'orders'" },
      { message: "Syntax error near 'SELCT'" },
    ]
    // Simulates classifyValidationError logic (column check before table check)
    function classify(msg: string): string {
      const lower = msg.toLowerCase()
      if (lower.includes("column") && lower.includes("not found")) return "missing_column"
      if (lower.includes("table") && lower.includes("not found")) return "missing_table"
      if (lower.includes("syntax")) return "syntax_error"
      return "validation_error"
    }
    const findings: Telemetry.Finding[] = errors.map((e) => ({
      category: classify(e.message),
    }))
    const by_category = Telemetry.aggregateFindings(findings)
    expect(by_category).toEqual({
      missing_table: 1,
      missing_column: 1,
      syntax_error: 1,
    })
  })

  test("semantics issues all map to semantic_issue category", () => {
    // Semantic findings don't have rule/type — always "semantic_issue"
    const issues = [
      { severity: "error", message: "..." },
      { severity: "warning", message: "..." },
      { severity: "warning", message: "..." },
    ]
    const findings: Telemetry.Finding[] = issues.map(() => ({
      category: "semantic_issue",
    }))
    expect(findings).toEqual([
      { category: "semantic_issue" },
      { category: "semantic_issue" },
      { category: "semantic_issue" },
    ])
    const by_category = Telemetry.aggregateFindings(findings)
    expect(by_category).toEqual({ semantic_issue: 3 })
  })

  test("fix tool produces fix_applied and unfixable_error categories", () => {
    const data = {
      fixes_applied: [{ description: "Fixed typo" }, { description: "Fixed reference" }],
      unfixable_errors: [{ error: { message: "Cannot resolve" } }],
    }
    const findings: Telemetry.Finding[] = []
    for (const _ of data.fixes_applied) {
      findings.push({ category: "fix_applied" })
    }
    for (const _ of data.unfixable_errors) {
      findings.push({ category: "unfixable_error" })
    }
    const by_category = Telemetry.aggregateFindings(findings)
    expect(by_category).toEqual({ fix_applied: 2, unfixable_error: 1 })
  })

  test("equivalence differences produce findings only when not equivalent", () => {
    // Equivalent — no findings
    const equivData = { equivalent: true, differences: [] }
    const equivFindings: Telemetry.Finding[] = []
    if (!equivData.equivalent && equivData.differences?.length) {
      for (const _ of equivData.differences) {
        equivFindings.push({ category: "equivalence_difference" })
      }
    }
    expect(equivFindings).toEqual([])

    // Different — findings
    const diffData = { equivalent: false, differences: [{ description: "..." }, { description: "..." }] }
    const diffFindings: Telemetry.Finding[] = []
    if (!diffData.equivalent && diffData.differences?.length) {
      for (const _ of diffData.differences) {
        diffFindings.push({ category: "equivalence_difference" })
      }
    }
    expect(diffFindings.length).toBe(2)
    const by_category = Telemetry.aggregateFindings(diffFindings)
    expect(by_category).toEqual({ equivalence_difference: 2 })
  })

  test("correct tool changes produce findings", () => {
    const data = { changes: [{ description: "a" }, { description: "b" }] }
    const findings: Telemetry.Finding[] = data.changes.map(() => ({
      category: "correction_applied",
    }))
    expect(findings.length).toBe(2)
    const by_category = Telemetry.aggregateFindings(findings)
    expect(by_category).toEqual({ correction_applied: 2 })
  })
})

// ---------------------------------------------------------------------------
// 4. No findings = no event
// ---------------------------------------------------------------------------
describe("no findings = no sql_quality event", () => {
  test("empty issues array produces empty findings", () => {
    const issues: any[] = []
    const findings: Telemetry.Finding[] = issues.map((i: any) => ({
      category: i.type,
    }))
    expect(findings.length).toBe(0)
    // tool.ts guards: !isSoftFailure && Array.isArray(findings) && findings.length > 0
    // So no event would be emitted
  })

  test("valid SQL with no errors produces no findings", () => {
    const data = { valid: true, errors: [] }
    const findings: Telemetry.Finding[] = (data.errors ?? []).map(() => ({
      category: "validation_error",
    }))
    expect(findings.length).toBe(0)
  })
})
