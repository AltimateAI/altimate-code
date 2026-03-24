// altimate_change start — tests for check CLI command helpers
import { describe, test, expect } from "bun:test"
import {
  normalizeSeverity,
  filterBySeverity,
  toCategoryResult,
  formatText,
  buildCheckOutput,
  VALID_CHECKS,
  SEVERITY_RANK,
  type Finding,
  type CheckOutput,
  type CheckCategoryResult,
} from "../../src/cli/cmd/check-helpers"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "test.sql",
    severity: "warning",
    message: "test finding",
    ...overrides,
  }
}

function makeOutput(overrides: Partial<CheckOutput> = {}): CheckOutput {
  return {
    version: 1,
    files_checked: 0,
    checks_run: [],
    schema_resolved: false,
    results: {},
    summary: {
      total_findings: 0,
      errors: 0,
      warnings: 0,
      info: 0,
      pass: true,
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. normalizeSeverity
// ---------------------------------------------------------------------------

describe("normalizeSeverity", () => {
  test('maps "error" to "error"', () => {
    expect(normalizeSeverity("error")).toBe("error")
  })

  test('maps "fatal" to "error"', () => {
    expect(normalizeSeverity("fatal")).toBe("error")
  })

  test('maps "critical" to "error"', () => {
    expect(normalizeSeverity("critical")).toBe("error")
  })

  test('maps "warn" to "warning"', () => {
    expect(normalizeSeverity("warn")).toBe("warning")
  })

  test('maps "warning" to "warning"', () => {
    expect(normalizeSeverity("warning")).toBe("warning")
  })

  test('maps "info" to "info"', () => {
    expect(normalizeSeverity("info")).toBe("info")
  })

  test('maps undefined to "warning"', () => {
    expect(normalizeSeverity(undefined)).toBe("warning")
  })

  test('maps unknown string to "info"', () => {
    expect(normalizeSeverity("unknown")).toBe("info")
    expect(normalizeSeverity("notice")).toBe("info")
    expect(normalizeSeverity("debug")).toBe("info")
  })

  test("is case-insensitive", () => {
    expect(normalizeSeverity("ERROR")).toBe("error")
    expect(normalizeSeverity("Warning")).toBe("warning")
    expect(normalizeSeverity("FATAL")).toBe("error")
    expect(normalizeSeverity("CRITICAL")).toBe("error")
    expect(normalizeSeverity("Warn")).toBe("warning")
    expect(normalizeSeverity("INFO")).toBe("info")
  })

  test('maps empty string to "warning"', () => {
    expect(normalizeSeverity("")).toBe("warning")
  })
})

// ---------------------------------------------------------------------------
// 2. filterBySeverity
// ---------------------------------------------------------------------------

describe("filterBySeverity", () => {
  const errorFinding = makeFinding({ severity: "error", message: "err" })
  const warningFinding = makeFinding({ severity: "warning", message: "warn" })
  const infoFinding = makeFinding({ severity: "info", message: "info" })
  const allFindings = [errorFinding, warningFinding, infoFinding]

  test('filters to warning+ when minSeverity is "warning"', () => {
    const result = filterBySeverity(allFindings, "warning")
    expect(result).toHaveLength(2)
    expect(result).toContain(errorFinding)
    expect(result).toContain(warningFinding)
    expect(result).not.toContain(infoFinding)
  })

  test('filters to error only when minSeverity is "error"', () => {
    const result = filterBySeverity(allFindings, "error")
    expect(result).toHaveLength(1)
    expect(result).toContain(errorFinding)
  })

  test('returns all when minSeverity is "info"', () => {
    const result = filterBySeverity(allFindings, "info")
    expect(result).toHaveLength(3)
  })

  test("returns empty array for empty input", () => {
    const result = filterBySeverity([], "error")
    expect(result).toEqual([])
  })

  test("returns empty array when no findings match threshold", () => {
    const result = filterBySeverity([infoFinding], "error")
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. toCategoryResult
// ---------------------------------------------------------------------------

describe("toCategoryResult", () => {
  test("counts errors and warnings correctly", () => {
    const findings = [
      makeFinding({ severity: "error" }),
      makeFinding({ severity: "error" }),
      makeFinding({ severity: "warning" }),
    ]
    const result = toCategoryResult(findings)
    expect(result.error_count).toBe(2)
    expect(result.warning_count).toBe(1)
    expect(result.findings).toHaveLength(3)
  })

  test("returns zero counts for empty findings", () => {
    const result = toCategoryResult([])
    expect(result.error_count).toBe(0)
    expect(result.warning_count).toBe(0)
    expect(result.findings).toHaveLength(0)
  })

  test("counts info findings correctly (not counted as error or warning)", () => {
    const findings = [makeFinding({ severity: "info" }), makeFinding({ severity: "info" })]
    const result = toCategoryResult(findings)
    expect(result.error_count).toBe(0)
    expect(result.warning_count).toBe(0)
    expect(result.findings).toHaveLength(2)
  })

  test("preserves finding references", () => {
    const original = makeFinding({ message: "original" })
    const result = toCategoryResult([original])
    expect(result.findings[0]).toBe(original)
  })
})

// ---------------------------------------------------------------------------
// 4. formatText
// ---------------------------------------------------------------------------

describe("formatText", () => {
  test("formats empty results correctly", () => {
    const output = makeOutput({
      files_checked: 0,
      checks_run: ["lint"],
      results: { lint: { findings: [], error_count: 0, warning_count: 0 } },
    })
    const text = formatText(output)
    expect(text).toContain("Checked 0 file(s) with [lint]")
    expect(text).toContain("0 finding(s)")
    expect(text).toContain("PASS")
    expect(text).not.toContain("--- LINT ---")
  })

  test("formats findings with file:line:column", () => {
    const finding = makeFinding({
      file: "models/stg.sql",
      line: 10,
      column: 5,
      rule: "L003",
      severity: "warning",
      message: "SELECT * detected",
    })
    const output = makeOutput({
      files_checked: 1,
      checks_run: ["lint"],
      results: { lint: toCategoryResult([finding]) },
      summary: { total_findings: 1, errors: 0, warnings: 1, info: 0, pass: true },
    })
    const text = formatText(output)
    expect(text).toContain("models/stg.sql:10:5")
    expect(text).toContain("[L003]")
    expect(text).toContain("WARNING")
    expect(text).toContain("SELECT * detected")
  })

  test("formats findings with line but no column", () => {
    const finding = makeFinding({ file: "test.sql", line: 42, severity: "error", message: "bad" })
    const output = makeOutput({
      files_checked: 1,
      checks_run: ["lint"],
      results: { lint: toCategoryResult([finding]) },
      summary: { total_findings: 1, errors: 1, warnings: 0, info: 0, pass: false },
    })
    const text = formatText(output)
    expect(text).toContain("test.sql:42:")
    // No column appended after the line number (42: message, not 42:5)
    expect(text).not.toMatch(/test\.sql:42:\d/)
  })

  test("includes suggestions when present", () => {
    const finding = makeFinding({
      message: "Use explicit columns",
      suggestion: "Replace * with column names",
    })
    const output = makeOutput({
      files_checked: 1,
      checks_run: ["lint"],
      results: { lint: toCategoryResult([finding]) },
      summary: { total_findings: 1, errors: 0, warnings: 1, info: 0, pass: true },
    })
    const text = formatText(output)
    expect(text).toContain("suggestion: Replace * with column names")
  })

  test("omits suggestions when absent", () => {
    const finding = makeFinding({ message: "No suggestion here" })
    const output = makeOutput({
      files_checked: 1,
      checks_run: ["lint"],
      results: { lint: toCategoryResult([finding]) },
      summary: { total_findings: 1, errors: 0, warnings: 1, info: 0, pass: true },
    })
    const text = formatText(output)
    expect(text).not.toContain("suggestion:")
  })

  test("shows PASS when summary.pass is true", () => {
    const output = makeOutput({ summary: { total_findings: 0, errors: 0, warnings: 0, info: 0, pass: true } })
    const text = formatText(output)
    expect(text).toContain("PASS")
    expect(text).not.toContain("FAIL")
  })

  test("shows FAIL when summary.pass is false", () => {
    const output = makeOutput({ summary: { total_findings: 1, errors: 1, warnings: 0, info: 0, pass: false } })
    const text = formatText(output)
    expect(text).toContain("FAIL")
  })

  test("includes category headers for non-empty categories", () => {
    const output = makeOutput({
      files_checked: 1,
      checks_run: ["lint", "safety"],
      results: {
        lint: toCategoryResult([makeFinding({ severity: "warning" })]),
        safety: toCategoryResult([]),
      },
      summary: { total_findings: 1, errors: 0, warnings: 1, info: 0, pass: true },
    })
    const text = formatText(output)
    expect(text).toContain("--- LINT ---")
    expect(text).not.toContain("--- SAFETY ---")
  })

  test("shows schema resolved when true", () => {
    const output = makeOutput({ schema_resolved: true, checks_run: ["validate"] })
    const text = formatText(output)
    expect(text).toContain("Schema: resolved")
  })

  test("does not show schema resolved when false", () => {
    const output = makeOutput({ schema_resolved: false, checks_run: ["lint"] })
    const text = formatText(output)
    expect(text).not.toContain("Schema: resolved")
  })

  test("formats multiple checks in header", () => {
    const output = makeOutput({ checks_run: ["lint", "safety", "pii"] })
    const text = formatText(output)
    expect(text).toContain("[lint, safety, pii]")
  })
})

// ---------------------------------------------------------------------------
// 5. buildCheckOutput
// ---------------------------------------------------------------------------

describe("buildCheckOutput", () => {
  test("sets version to 1", () => {
    const output = buildCheckOutput({
      filesChecked: 0,
      checksRun: [],
      schemaResolved: false,
      results: {},
      failOn: "none",
    })
    expect(output.version).toBe(1)
  })

  test("counts files_checked correctly", () => {
    const output = buildCheckOutput({
      filesChecked: 5,
      checksRun: ["lint"],
      schemaResolved: false,
      results: { lint: toCategoryResult([]) },
      failOn: "none",
    })
    expect(output.files_checked).toBe(5)
  })

  test("lists checks_run correctly", () => {
    const output = buildCheckOutput({
      filesChecked: 1,
      checksRun: ["lint", "safety", "pii"],
      schemaResolved: false,
      results: {},
      failOn: "none",
    })
    expect(output.checks_run).toEqual(["lint", "safety", "pii"])
  })

  test("reflects schema presence", () => {
    const withSchema = buildCheckOutput({
      filesChecked: 1,
      checksRun: [],
      schemaResolved: true,
      results: {},
      failOn: "none",
    })
    expect(withSchema.schema_resolved).toBe(true)

    const withoutSchema = buildCheckOutput({
      filesChecked: 1,
      checksRun: [],
      schemaResolved: false,
      results: {},
      failOn: "none",
    })
    expect(withoutSchema.schema_resolved).toBe(false)
  })

  test("summary totals match finding counts", () => {
    const results: Record<string, CheckCategoryResult> = {
      lint: toCategoryResult([makeFinding({ severity: "error" }), makeFinding({ severity: "warning" })]),
      safety: toCategoryResult([makeFinding({ severity: "info" })]),
    }
    const output = buildCheckOutput({
      filesChecked: 2,
      checksRun: ["lint", "safety"],
      schemaResolved: false,
      results,
      failOn: "none",
    })
    expect(output.summary.total_findings).toBe(3)
    expect(output.summary.errors).toBe(1)
    expect(output.summary.warnings).toBe(1)
    expect(output.summary.info).toBe(1)
  })

  test('pass is true when failOn is "none" regardless of findings', () => {
    const results = {
      lint: toCategoryResult([makeFinding({ severity: "error" })]),
    }
    const output = buildCheckOutput({
      filesChecked: 1,
      checksRun: ["lint"],
      schemaResolved: false,
      results,
      failOn: "none",
    })
    expect(output.summary.pass).toBe(true)
  })

  test('pass is false when failOn is "error" and errors exist', () => {
    const results = {
      lint: toCategoryResult([makeFinding({ severity: "error" })]),
    }
    const output = buildCheckOutput({
      filesChecked: 1,
      checksRun: ["lint"],
      schemaResolved: false,
      results,
      failOn: "error",
    })
    expect(output.summary.pass).toBe(false)
  })

  test('pass is true when failOn is "error" and only warnings exist', () => {
    const results = {
      lint: toCategoryResult([makeFinding({ severity: "warning" })]),
    }
    const output = buildCheckOutput({
      filesChecked: 1,
      checksRun: ["lint"],
      schemaResolved: false,
      results,
      failOn: "error",
    })
    expect(output.summary.pass).toBe(true)
  })

  test('pass is false when failOn is "warning" and warnings exist', () => {
    const results = {
      lint: toCategoryResult([makeFinding({ severity: "warning" })]),
    }
    const output = buildCheckOutput({
      filesChecked: 1,
      checksRun: ["lint"],
      schemaResolved: false,
      results,
      failOn: "warning",
    })
    expect(output.summary.pass).toBe(false)
  })

  test('pass is false when failOn is "warning" and errors exist', () => {
    const results = {
      lint: toCategoryResult([makeFinding({ severity: "error" })]),
    }
    const output = buildCheckOutput({
      filesChecked: 1,
      checksRun: ["lint"],
      schemaResolved: false,
      results,
      failOn: "warning",
    })
    expect(output.summary.pass).toBe(false)
  })

  test('pass is true when failOn is "warning" and only info exists', () => {
    const results = {
      lint: toCategoryResult([makeFinding({ severity: "info" })]),
    }
    const output = buildCheckOutput({
      filesChecked: 1,
      checksRun: ["lint"],
      schemaResolved: false,
      results,
      failOn: "warning",
    })
    expect(output.summary.pass).toBe(true)
  })

  test("handles empty results", () => {
    const output = buildCheckOutput({
      filesChecked: 0,
      checksRun: [],
      schemaResolved: false,
      results: {},
      failOn: "error",
    })
    expect(output.summary.total_findings).toBe(0)
    expect(output.summary.pass).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. VALID_CHECKS and SEVERITY_RANK constants
// ---------------------------------------------------------------------------

describe("VALID_CHECKS", () => {
  test("contains all expected check names", () => {
    const expected = ["lint", "validate", "safety", "policy", "pii", "semantic", "grade"]
    for (const check of expected) {
      expect(VALID_CHECKS.has(check)).toBe(true)
    }
  })

  test("does not contain unknown checks", () => {
    expect(VALID_CHECKS.has("unknown")).toBe(false)
    expect(VALID_CHECKS.has("format")).toBe(false)
    expect(VALID_CHECKS.has("")).toBe(false)
  })

  test("has exactly 7 checks", () => {
    expect(VALID_CHECKS.size).toBe(7)
  })
})

describe("SEVERITY_RANK", () => {
  test("error > warning > info", () => {
    expect(SEVERITY_RANK.error).toBeGreaterThan(SEVERITY_RANK.warning)
    expect(SEVERITY_RANK.warning).toBeGreaterThan(SEVERITY_RANK.info)
  })

  test("has exactly 3 levels", () => {
    expect(Object.keys(SEVERITY_RANK)).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// 7. Edge cases and integration scenarios
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("formatText handles findings without line, column, or rule", () => {
    const finding = makeFinding({
      file: "orphan.sql",
      severity: "error",
      message: "something broke",
      line: undefined,
      column: undefined,
      rule: undefined,
    })
    const output = makeOutput({
      files_checked: 1,
      checks_run: ["lint"],
      results: { lint: toCategoryResult([finding]) },
      summary: { total_findings: 1, errors: 1, warnings: 0, info: 0, pass: false },
    })
    const text = formatText(output)
    expect(text).toContain("ERROR orphan.sql: something broke")
    // The line should contain "ERROR orphan.sql:" (no location) followed by the message
    const lines = text.split("\n")
    const findingLine = lines.find((l) => l.includes("orphan.sql"))
    expect(findingLine).toBeDefined()
    // No line number after filename (no :42 or :42:5 pattern)
    expect(findingLine).not.toMatch(/orphan\.sql:\d/)
    expect(findingLine).not.toContain("[")
  })

  test("filterBySeverity preserves original array order", () => {
    const findings = [
      makeFinding({ severity: "warning", message: "first" }),
      makeFinding({ severity: "error", message: "second" }),
      makeFinding({ severity: "warning", message: "third" }),
    ]
    const result = filterBySeverity(findings, "warning")
    expect(result[0].message).toBe("first")
    expect(result[1].message).toBe("second")
    expect(result[2].message).toBe("third")
  })

  test("toCategoryResult handles mixed severity findings", () => {
    const findings = [
      makeFinding({ severity: "error" }),
      makeFinding({ severity: "warning" }),
      makeFinding({ severity: "info" }),
      makeFinding({ severity: "error" }),
      makeFinding({ severity: "info" }),
    ]
    const result = toCategoryResult(findings)
    expect(result.error_count).toBe(2)
    expect(result.warning_count).toBe(1)
    expect(result.findings).toHaveLength(5)
  })

  test("buildCheckOutput aggregates findings across multiple categories", () => {
    const results = {
      lint: toCategoryResult([makeFinding({ severity: "error" }), makeFinding({ severity: "warning" })]),
      safety: toCategoryResult([makeFinding({ severity: "error" })]),
      pii: toCategoryResult([makeFinding({ severity: "warning" }), makeFinding({ severity: "info" })]),
    }
    const output = buildCheckOutput({
      filesChecked: 3,
      checksRun: ["lint", "safety", "pii"],
      schemaResolved: true,
      results,
      failOn: "error",
    })
    expect(output.summary.total_findings).toBe(5)
    expect(output.summary.errors).toBe(2)
    expect(output.summary.warnings).toBe(2)
    expect(output.summary.info).toBe(1)
    expect(output.summary.pass).toBe(false)
  })

  test("formatText renders multiple categories", () => {
    const output = makeOutput({
      files_checked: 2,
      checks_run: ["lint", "safety"],
      results: {
        lint: toCategoryResult([makeFinding({ severity: "warning", message: "lint warning" })]),
        safety: toCategoryResult([makeFinding({ severity: "error", message: "safety error" })]),
      },
      summary: { total_findings: 2, errors: 1, warnings: 1, info: 0, pass: false },
    })
    const text = formatText(output)
    expect(text).toContain("--- LINT ---")
    expect(text).toContain("--- SAFETY ---")
    expect(text).toContain("lint warning")
    expect(text).toContain("safety error")
  })

  test("normalizeSeverity handles whitespace-padded strings via toLowerCase", () => {
    // normalizeSeverity does not trim, so " error" becomes "info" (fallthrough)
    expect(normalizeSeverity(" error")).toBe("info")
  })
})
// altimate_change end
