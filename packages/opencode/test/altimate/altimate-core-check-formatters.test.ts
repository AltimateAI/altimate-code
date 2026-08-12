import { describe, test, expect } from "bun:test"
import { formatCheckTitle, formatCheck } from "../../src/altimate/tools/altimate-core-check"

describe("formatCheckTitle", () => {
  test("returns PASS for all-clean result", () => {
    const data = {
      validation: { valid: true },
      lint: { clean: true, findings: [] },
      safety: { safe: true },
      pii: { findings: [] },
    }
    expect(formatCheckTitle(data)).toBe("PASS")
  })

  test("lists all failure categories when everything fails", () => {
    const data = {
      validation: { valid: false, errors: [{ message: "bad syntax" }] },
      lint: { clean: false, findings: [{ rule: "L001" }, { rule: "L002" }] },
      safety: { safe: false, threats: [{ type: "injection" }] },
      pii: { findings: [{ column: "ssn", category: "SSN" }] },
    }
    const result = formatCheckTitle(data)
    expect(result).toContain("validation errors")
    expect(result).toContain("2 lint findings")
    expect(result).toContain("safety threats")
    expect(result).toContain("PII detected")
  })

  test("treats missing sections as failures (undefined is falsy)", () => {
    // When data is empty, !undefined is true, so each section looks like a failure
    const data = {} as Record<string, any>
    const result = formatCheckTitle(data)
    expect(result).toContain("validation errors")
    expect(result).toContain("safety threats")
    // lint.findings?.length is undefined, ?? 0 yields "0 lint findings"
    expect(result).toContain("0 lint findings")
  })

  test("shows lint finding count when clean is false but findings is undefined", () => {
    const data = {
      validation: { valid: true },
      lint: { clean: false },
      safety: { safe: true },
      pii: { findings: [] },
    }
    // lint.findings?.length is undefined, ?? 0 yields "0 lint findings"
    expect(formatCheckTitle(data)).toBe("0 lint findings")
  })

  test("only shows failing sections, not passing ones", () => {
    const data = {
      validation: { valid: true },
      lint: { clean: true },
      safety: { safe: false, threats: [{ type: "drop_table" }] },
      pii: { findings: [] },
    }
    expect(formatCheckTitle(data)).toBe("safety threats")
  })
})

describe("formatCheck", () => {
  test("formats all-pass result with four sections", () => {
    const data = {
      validation: { valid: true },
      lint: { clean: true },
      safety: { safe: true },
      pii: { findings: [] },
    }
    const output = formatCheck(data)
    expect(output).toContain("=== Validation ===")
    expect(output).toContain("Valid SQL.")
    expect(output).toContain("=== Lint ===")
    expect(output).toContain("No lint findings.")
    expect(output).toContain("=== Safety ===")
    expect(output).toContain("Safe — no threats.")
    expect(output).toContain("=== PII ===")
    expect(output).toContain("No PII detected.")
  })

  test("formats validation errors", () => {
    const data = {
      validation: { valid: false, errors: [{ message: "syntax error at line 3" }, { message: "unknown column" }] },
      lint: { clean: true },
      safety: { safe: true },
      pii: {},
    }
    const output = formatCheck(data)
    expect(output).toContain("Invalid: syntax error at line 3; unknown column")
  })

  test("formats lint findings with severity and rule", () => {
    const data = {
      validation: { valid: true },
      lint: {
        clean: false,
        findings: [
          { severity: "warning", rule: "L001", message: "Unnecessary whitespace" },
          { severity: "error", rule: "L003", message: "Indentation not consistent" },
        ],
      },
      safety: { safe: true },
      pii: {},
    }
    const output = formatCheck(data)
    expect(output).toContain("[warning] L001: Unnecessary whitespace")
    expect(output).toContain("[error] L003: Indentation not consistent")
  })

  test("formats safety threats", () => {
    const data = {
      validation: { valid: true },
      lint: { clean: true },
      safety: {
        safe: false,
        threats: [{ severity: "critical", type: "sql_injection", description: "Tautology detected: 1=1" }],
      },
      pii: {},
    }
    const output = formatCheck(data)
    expect(output).toContain("[critical] sql_injection: Tautology detected: 1=1")
  })

  test("formats PII exposures from the engine PiiQueryResult shape", () => {
    const data = {
      validation: { valid: true },
      lint: { clean: true },
      safety: { safe: true },
      pii: {
        accesses_pii: true,
        risk_level: "High",
        pii_columns: [
          { table: "customers", column: "ssn", classification: "SSN", query_targets: [], suggested_masking: "'***'" },
          { table: "customers", column: "email", classification: { Custom: "WorkEmail" }, query_targets: ["contact"], suggested_masking: null },
        ],
      },
    }
    const output = formatCheck(data)
    expect(output).toContain("customers.ssn: SSN (masking: '***')")
    // { Custom: string } classifications must not render as [object Object]
    expect(output).toContain("customers.email: WorkEmail")
    expect(output).not.toContain("[object Object]")
  })

  test("formats PII findings via the legacy findings fallback", () => {
    const data = {
      validation: { valid: true },
      lint: { clean: true },
      safety: { safe: true },
      pii: { findings: [{ column: "ssn", category: "SSN", confidence: "high" }] },
    }
    const output = formatCheck(data)
    expect(output).toContain("ssn: SSN")
    expect(output).not.toContain("No PII detected")
  })

  test("handles empty/missing sections without crashing", () => {
    const data = {} as Record<string, any>
    const output = formatCheck(data)
    // Should still produce all four section headers
    expect(output).toContain("=== Validation ===")
    expect(output).toContain("=== Lint ===")
    expect(output).toContain("=== Safety ===")
    expect(output).toContain("=== PII ===")
    // validation.valid is undefined (falsy) → "Invalid: unknown"
    expect(output).toContain("Invalid:")
  })
})
