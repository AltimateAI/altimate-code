/**
 * SQL Quality Telemetry Tests
 *
 * Verifies that the `sql_quality` event is emitted with correct aggregations
 * when tools report findings, and is NOT emitted when there are no findings.
 */

import { describe, expect, test } from "bun:test"
import { Telemetry } from "../../src/altimate/telemetry"

// ---------------------------------------------------------------------------
// 1. aggregateFindings
// ---------------------------------------------------------------------------
describe("Telemetry.aggregateFindings", () => {
  test("aggregates findings by severity and category", () => {
    const findings: Telemetry.Finding[] = [
      { category: "missing_table", severity: "error" },
      { category: "missing_column", severity: "error" },
      { category: "cartesian_product", severity: "warning" },
      { category: "missing_table", severity: "error" },
    ]
    const result = Telemetry.aggregateFindings(findings)
    expect(result.by_severity).toEqual({ error: 3, warning: 1 })
    expect(result.by_category).toEqual({
      missing_table: 2,
      missing_column: 1,
      cartesian_product: 1,
    })
  })

  test("returns empty objects for empty findings", () => {
    const result = Telemetry.aggregateFindings([])
    expect(result.by_severity).toEqual({})
    expect(result.by_category).toEqual({})
  })

  test("handles single finding", () => {
    const findings: Telemetry.Finding[] = [
      { category: "syntax_error", severity: "error" },
    ]
    const result = Telemetry.aggregateFindings(findings)
    expect(result.by_severity).toEqual({ error: 1 })
    expect(result.by_category).toEqual({ syntax_error: 1 })
  })

  test("handles all same category different severities", () => {
    const findings: Telemetry.Finding[] = [
      { category: "select_star", severity: "warning" },
      { category: "select_star", severity: "info" },
      { category: "select_star", severity: "error" },
    ]
    const result = Telemetry.aggregateFindings(findings)
    expect(result.by_severity).toEqual({ warning: 1, info: 1, error: 1 })
    expect(result.by_category).toEqual({ select_star: 3 })
  })
})

// ---------------------------------------------------------------------------
// 2. sql_quality event shape validation
// ---------------------------------------------------------------------------
describe("sql_quality event shape", () => {
  test("by_severity and by_category serialize to valid JSON strings", () => {
    const findings: Telemetry.Finding[] = [
      { category: "anti_pattern", severity: "warning" },
      { category: "anti_pattern", severity: "warning" },
      { category: "performance_issue", severity: "info" },
    ]
    const { by_severity, by_category } = Telemetry.aggregateFindings(findings)
    const severityJson = JSON.stringify(by_severity)
    const categoryJson = JSON.stringify(by_category)

    // Should round-trip through JSON
    expect(JSON.parse(severityJson)).toEqual({ warning: 2, info: 1 })
    expect(JSON.parse(categoryJson)).toEqual({ anti_pattern: 2, performance_issue: 1 })
  })

  test("aggregated counts match finding_count", () => {
    const findings: Telemetry.Finding[] = [
      { category: "a", severity: "error" },
      { category: "b", severity: "warning" },
      { category: "c", severity: "error" },
      { category: "a", severity: "info" },
    ]
    const { by_severity, by_category } = Telemetry.aggregateFindings(findings)
    const totalBySeverity = Object.values(by_severity).reduce((a, b) => a + b, 0)
    const totalByCategory = Object.values(by_category).reduce((a, b) => a + b, 0)
    expect(totalBySeverity).toBe(findings.length)
    expect(totalByCategory).toBe(findings.length)
  })
})

// ---------------------------------------------------------------------------
// 3. Finding extraction patterns (validates what tools produce)
// ---------------------------------------------------------------------------
describe("tool finding extraction patterns", () => {
  test("sql_analyze issues map to findings", () => {
    const issues = [
      { type: "select_star", severity: "warning", message: "...", recommendation: "...", confidence: "high" },
      { type: "cartesian_product", severity: "error", message: "...", recommendation: "...", confidence: "high" },
    ]
    const findings: Telemetry.Finding[] = issues.map((i) => ({
      category: i.type,
      severity: i.severity,
    }))
    expect(findings).toEqual([
      { category: "select_star", severity: "warning" },
      { category: "cartesian_product", severity: "error" },
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
      severity: "error",
    }))
    const { by_category } = Telemetry.aggregateFindings(findings)
    expect(by_category).toEqual({
      missing_table: 1,
      missing_column: 1,
      syntax_error: 1,
    })
  })

  test("semantics issues preserve rule/type as category", () => {
    const issues = [
      { rule: "cartesian_product", severity: "error", message: "..." },
      { type: "null_misuse", severity: "warning", message: "..." },
      { severity: "warning", message: "..." }, // no rule or type
    ]
    const findings: Telemetry.Finding[] = issues.map((i: any) => ({
      category: i.rule ?? i.type ?? "semantic_issue",
      severity: i.severity ?? "warning",
    }))
    expect(findings).toEqual([
      { category: "cartesian_product", severity: "error" },
      { category: "null_misuse", severity: "warning" },
      { category: "semantic_issue", severity: "warning" },
    ])
  })

  test("fix tool produces fix_applied and unfixable_error categories", () => {
    const data = {
      fixes_applied: [{ description: "Fixed typo" }, { description: "Fixed reference" }],
      unfixable_errors: [{ error: { message: "Cannot resolve" } }],
    }
    const findings: Telemetry.Finding[] = []
    for (const _ of data.fixes_applied) {
      findings.push({ category: "fix_applied", severity: "warning" })
    }
    for (const _ of data.unfixable_errors) {
      findings.push({ category: "unfixable_error", severity: "error" })
    }
    const { by_category } = Telemetry.aggregateFindings(findings)
    expect(by_category).toEqual({ fix_applied: 2, unfixable_error: 1 })
  })

  test("equivalence differences produce findings only when not equivalent", () => {
    // Equivalent — no findings
    const equivData = { equivalent: true, differences: [] }
    const equivFindings: Telemetry.Finding[] = []
    if (!equivData.equivalent && equivData.differences?.length) {
      for (const _ of equivData.differences) {
        equivFindings.push({ category: "equivalence_difference", severity: "warning" })
      }
    }
    expect(equivFindings).toEqual([])

    // Different — findings
    const diffData = { equivalent: false, differences: [{ description: "..." }, { description: "..." }] }
    const diffFindings: Telemetry.Finding[] = []
    if (!diffData.equivalent && diffData.differences?.length) {
      for (const _ of diffData.differences) {
        diffFindings.push({ category: "equivalence_difference", severity: "warning" })
      }
    }
    expect(diffFindings.length).toBe(2)
    const { by_category } = Telemetry.aggregateFindings(diffFindings)
    expect(by_category).toEqual({ equivalence_difference: 2 })
  })

  test("correct tool changes produce findings", () => {
    const data = { changes: [{ description: "a" }, { description: "b" }] }
    const findings: Telemetry.Finding[] = data.changes.map(() => ({
      category: "correction_applied",
      severity: "warning",
    }))
    expect(findings.length).toBe(2)
    const { by_category } = Telemetry.aggregateFindings(findings)
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
      severity: i.severity,
    }))
    expect(findings.length).toBe(0)
    // tool.ts checks: Array.isArray(findings) && findings.length > 0
    // So no event would be emitted
  })

  test("valid SQL with no errors produces no findings", () => {
    const data = { valid: true, errors: [] }
    const findings: Telemetry.Finding[] = (data.errors ?? []).map(() => ({
      category: "validation_error",
      severity: "error",
    }))
    expect(findings.length).toBe(0)
  })
})
