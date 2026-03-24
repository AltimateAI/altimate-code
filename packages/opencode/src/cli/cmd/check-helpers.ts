// altimate_change start — check-helpers: extracted helpers for deterministic SQL check command
// These are exported separately so they can be unit-tested without importing
// the full CLI command (which has side-effects via yargs).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Finding {
  file: string
  line?: number
  column?: number
  code?: string
  rule?: string
  severity: "error" | "warning" | "info"
  message: string
  suggestion?: string
}

export interface CheckCategoryResult {
  findings: Finding[]
  error_count: number
  warning_count: number
  [key: string]: unknown
}

export interface CheckOutput {
  version: 1
  files_checked: number
  checks_run: string[]
  schema_resolved: boolean
  results: Record<string, CheckCategoryResult>
  summary: {
    total_findings: number
    errors: number
    warnings: number
    info: number
    pass: boolean
  }
}

export type Severity = "error" | "warning" | "info"

export const SEVERITY_RANK: Record<Severity, number> = { error: 2, warning: 1, info: 0 }

export const VALID_CHECKS = new Set(["lint", "validate", "safety", "policy", "pii", "semantic", "grade"])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeSeverity(s?: string | unknown): Severity {
  if (!s || typeof s !== "string") return "warning"
  const lower = s.toLowerCase()
  if (lower === "error" || lower === "fatal" || lower === "critical") return "error"
  if (lower === "warning" || lower === "warn") return "warning"
  return "info"
}

export function filterBySeverity(findings: Finding[], minSeverity: Severity): Finding[] {
  const minRank = SEVERITY_RANK[minSeverity]
  return findings.filter((f) => SEVERITY_RANK[f.severity] >= minRank)
}

export function toCategoryResult(findings: Finding[]): CheckCategoryResult {
  return {
    findings,
    error_count: findings.filter((f) => f.severity === "error").length,
    warning_count: findings.filter((f) => f.severity === "warning").length,
  }
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

export function formatText(output: CheckOutput): string {
  const lines: string[] = []

  lines.push(`Checked ${output.files_checked} file(s) with [${output.checks_run.join(", ")}]`)
  if (output.schema_resolved) {
    lines.push("Schema: resolved")
  }
  lines.push("")

  for (const [category, catResult] of Object.entries(output.results)) {
    if (catResult.findings.length === 0) continue
    lines.push(`--- ${category.toUpperCase()} ---`)
    for (const f of catResult.findings) {
      const loc = f.line ? `:${f.line}${f.column ? `:${f.column}` : ""}` : ""
      const rule = f.rule ? ` [${f.rule}]` : ""
      lines.push(`  ${f.severity.toUpperCase()} ${f.file}${loc}${rule}: ${f.message}`)
      if (f.suggestion) {
        lines.push(`    suggestion: ${f.suggestion}`)
      }
    }
    lines.push("")
  }

  const s = output.summary
  lines.push(`${s.total_findings} finding(s): ${s.errors} error(s), ${s.warnings} warning(s), ${s.info} info`)
  lines.push(s.pass ? "PASS" : "FAIL")

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Output builder
// ---------------------------------------------------------------------------

export function buildCheckOutput(opts: {
  filesChecked: number
  checksRun: string[]
  schemaResolved: boolean
  results: Record<string, CheckCategoryResult>
  failOn: "none" | "warning" | "error"
}): CheckOutput {
  const allFindings = Object.values(opts.results).flatMap((r) => r.findings)
  const errors = allFindings.filter((f) => f.severity === "error").length
  const warnings = allFindings.filter((f) => f.severity === "warning").length
  const info = allFindings.filter((f) => f.severity === "info").length

  let pass = true
  if (opts.failOn === "error" && errors > 0) pass = false
  if (opts.failOn === "warning" && (errors > 0 || warnings > 0)) pass = false

  return {
    version: 1,
    files_checked: opts.filesChecked,
    checks_run: opts.checksRun,
    schema_resolved: opts.schemaResolved,
    results: opts.results,
    summary: {
      total_findings: allFindings.length,
      errors,
      warnings,
      info,
      pass,
    },
  }
}
// altimate_change end
