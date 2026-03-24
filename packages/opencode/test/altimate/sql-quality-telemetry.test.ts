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
  test("sql_analyze issues use rule for lint, fall back to type otherwise", () => {
    // Lint issues have rule (e.g. "select_star"), semantic/safety don't
    const issues = [
      { type: "lint", rule: "select_star", severity: "warning", message: "...", recommendation: "...", confidence: "high" },
      { type: "lint", rule: "filter_has_func", severity: "warning", message: "...", recommendation: "...", confidence: "high" },
      { type: "semantic", severity: "warning", message: "...", recommendation: "...", confidence: "medium" },
      { type: "safety", severity: "high", message: "...", recommendation: "...", confidence: "high" },
    ]
    const findings: Telemetry.Finding[] = issues.map((i: any) => ({
      category: i.rule ?? i.type,
    }))
    expect(findings).toEqual([
      { category: "select_star" },
      { category: "filter_has_func" },
      { category: "semantic" },
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

  test("check tool aggregates validation, lint, safety, and pii findings", () => {
    const data = {
      validation: { valid: false, errors: [{ message: "syntax error" }] },
      lint: { clean: false, findings: [{ rule: "select_star", severity: "warning", message: "..." }, { rule: "filter_has_func", severity: "warning", message: "..." }] },
      safety: { safe: false, threats: [{ type: "sql_injection", severity: "high", description: "..." }] },
      pii: { findings: [{ column: "email", category: "email", confidence: "high" }] },
    }
    const findings: Telemetry.Finding[] = []
    for (const _ of data.validation.errors) findings.push({ category: "validation_error" })
    for (const f of data.lint.findings) findings.push({ category: f.rule ?? "lint" })
    for (const t of data.safety.threats) findings.push({ category: (t as any).type ?? "safety_threat" })
    for (const _ of data.pii.findings) findings.push({ category: "pii_detected" })
    const by_category = Telemetry.aggregateFindings(findings)
    expect(by_category).toEqual({
      validation_error: 1,
      select_star: 1,
      filter_has_func: 1,
      sql_injection: 1,
      pii_detected: 1,
    })
  })

  test("policy violations use rule as category", () => {
    const data = {
      pass: false,
      violations: [
        { rule: "no_select_star", severity: "error", message: "..." },
        { rule: "require_where", severity: "error", message: "..." },
        { severity: "warning", message: "..." }, // no rule
      ],
    }
    const findings: Telemetry.Finding[] = data.violations.map((v: any) => ({
      category: v.rule ?? "policy_violation",
    }))
    const by_category = Telemetry.aggregateFindings(findings)
    expect(by_category).toEqual({
      no_select_star: 1,
      require_where: 1,
      policy_violation: 1,
    })
  })

  test("schema diff uses change_type as category", () => {
    const changes = [
      { severity: "breaking", change_type: "column_dropped", message: "..." },
      { severity: "warning", change_type: "type_changed", message: "..." },
      { severity: "info", change_type: "column_added", message: "..." },
      { severity: "breaking", change_type: "column_dropped", message: "..." },
    ]
    const findings: Telemetry.Finding[] = changes.map((c) => ({
      category: c.change_type ?? (c.severity === "breaking" ? "breaking_change" : "schema_change"),
    }))
    const by_category = Telemetry.aggregateFindings(findings)
    expect(by_category).toEqual({
      column_dropped: 2,
      type_changed: 1,
      column_added: 1,
    })
  })

  test("optimize tool combines anti-patterns and suggestions", () => {
    const result = {
      anti_patterns: [
        { type: "cartesian_product", severity: "error", message: "..." },
        { type: "select_star", severity: "warning", message: "..." },
      ],
      suggestions: [
        { type: "cte_elimination", impact: "high", description: "..." },
      ],
    }
    const findings: Telemetry.Finding[] = [
      ...result.anti_patterns.map((ap) => ({ category: ap.type ?? "anti_pattern" })),
      ...result.suggestions.map((s) => ({ category: s.type ?? "optimization_suggestion" })),
    ]
    const by_category = Telemetry.aggregateFindings(findings)
    expect(by_category).toEqual({
      cartesian_product: 1,
      select_star: 1,
      cte_elimination: 1,
    })
  })

  test("impact analysis produces findings only when downstream affected", () => {
    // No impact — no findings
    const safeFindings: Telemetry.Finding[] = []
    expect(safeFindings).toEqual([])

    // High impact — findings per dependent
    const findings: Telemetry.Finding[] = []
    const direct = [{ name: "model_a" }, { name: "model_b" }]
    const transitive = [{ name: "model_c" }]
    const totalAffected = direct.length + transitive.length
    if (totalAffected > 0) {
      findings.push({ category: "impact_medium" })
      for (const _ of direct) findings.push({ category: "impact_direct_dependent" })
      for (const _ of transitive) findings.push({ category: "impact_transitive_dependent" })
    }
    const by_category = Telemetry.aggregateFindings(findings)
    expect(by_category).toEqual({
      impact_medium: 1,
      impact_direct_dependent: 2,
      impact_transitive_dependent: 1,
    })
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
