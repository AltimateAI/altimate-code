// altimate_change start — check: deterministic SQL check CLI command (no LLM required)
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Dispatcher } from "../../altimate/native"
import { readFileSync, existsSync } from "fs"
import { Glob } from "../../util/glob"
import path from "path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Finding {
  file: string
  line?: number
  column?: number
  code?: string
  rule?: string
  severity: "error" | "warning" | "info"
  message: string
  suggestion?: string
}

interface CheckCategoryResult {
  findings: Finding[]
  error_count: number
  warning_count: number
  [key: string]: unknown
}

interface CheckOutput {
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

type Severity = "error" | "warning" | "info"

const SEVERITY_RANK: Record<Severity, number> = { error: 2, warning: 1, info: 0 }

const VALID_CHECKS = new Set(["lint", "validate", "safety", "policy", "pii", "semantic", "grade"])

// ---------------------------------------------------------------------------
// Check runners — each calls Dispatcher.call() and normalizes to Finding[]
// ---------------------------------------------------------------------------

async function runLint(sql: string, file: string, schemaPath?: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.lint", {
      sql,
      schema_path: schemaPath ?? "",
      schema_context: undefined as any,
    })
    if (!result.success) return []
    const violations = (result.data.violations ?? result.data.findings ?? []) as Array<Record<string, unknown>>
    return violations.map((f) => ({
      file,
      line: f.line as number | undefined,
      column: f.column as number | undefined,
      code: f.code as string | undefined,
      rule: (f.rule ?? f.code) as string | undefined,
      severity: normalizeSeverity(f.severity as string),
      message: (f.message ?? f.description ?? "") as string,
      suggestion: f.suggestion as string | undefined,
    }))
  } catch (e) {
    console.error(`[lint] error processing ${file}: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

async function runValidate(sql: string, file: string, schemaPath?: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql,
      schema_path: schemaPath ?? "",
      schema_context: undefined as any,
    })
    if (result.success) return []
    const errors = (result.data.errors ?? result.data.findings ?? []) as Array<Record<string, unknown>>
    if (errors.length > 0) {
      return errors.map((f) => ({
        file,
        line: f.line as number | undefined,
        column: f.column as number | undefined,
        code: f.code as string | undefined,
        rule: "validate",
        severity: normalizeSeverity(f.severity as string) || ("error" as const),
        message: (f.message ?? f.description ?? "") as string,
        suggestion: f.suggestion as string | undefined,
      }))
    }
    // If no structured errors but validation failed, emit a single finding
    const errorMsg = result.error ?? result.data.error ?? "SQL validation failed"
    return [
      {
        file,
        rule: "validate",
        severity: "error",
        message: String(errorMsg),
      },
    ]
  } catch (e) {
    console.error(`[validate] error processing ${file}: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

async function runSafety(sql: string, file: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.safety", { sql })
    if (result.success && result.data.safe !== false) return []
    const issues = (result.data.issues ?? result.data.findings ?? []) as Array<Record<string, unknown>>
    if (issues.length > 0) {
      return issues.map((f) => ({
        file,
        line: f.line as number | undefined,
        column: f.column as number | undefined,
        code: f.code as string | undefined,
        rule: (f.rule ?? f.category ?? "safety") as string,
        severity: normalizeSeverity(f.severity as string) || ("warning" as const),
        message: (f.message ?? f.description ?? "") as string,
        suggestion: f.suggestion as string | undefined,
      }))
    }
    if (!result.success || result.data.safe === false) {
      return [
        {
          file,
          rule: "safety",
          severity: "warning",
          message: result.error ?? "SQL safety check flagged potential issues",
        },
      ]
    }
    return []
  } catch (e) {
    console.error(`[safety] error processing ${file}: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

async function runPolicy(sql: string, file: string, policyJson: string, schemaPath?: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.policy", {
      sql,
      policy_json: policyJson,
      schema_path: schemaPath ?? "",
      schema_context: undefined as any,
    })
    if (result.success && result.data.allowed !== false) return []
    const violations = (result.data.violations ?? result.data.findings ?? []) as Array<Record<string, unknown>>
    if (violations.length > 0) {
      return violations.map((f) => ({
        file,
        line: f.line as number | undefined,
        column: f.column as number | undefined,
        code: f.code as string | undefined,
        rule: (f.rule ?? f.policy ?? "policy") as string,
        severity: normalizeSeverity(f.severity as string) || ("error" as const),
        message: (f.message ?? f.description ?? "") as string,
        suggestion: f.suggestion as string | undefined,
      }))
    }
    if (result.data.allowed === false) {
      return [
        {
          file,
          rule: "policy",
          severity: "error",
          message: result.error ?? "SQL policy check failed",
        },
      ]
    }
    return []
  } catch (e) {
    console.error(`[policy] error processing ${file}: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

async function runPii(sql: string, file: string, schemaPath?: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.query_pii", {
      sql,
      schema_path: schemaPath ?? "",
      schema_context: undefined as any,
    })
    const piiFindings = (result.data.pii_columns ?? result.data.findings ?? []) as Array<Record<string, unknown>>
    return piiFindings.map((f) => ({
      file,
      line: f.line as number | undefined,
      column: f.column as number | undefined,
      code: f.code as string | undefined,
      rule: (f.category ?? f.pii_type ?? "pii") as string,
      severity: "warning" as const,
      message: (f.message ?? f.description ?? `PII detected: ${f.column_name ?? f.name ?? "unknown"}`) as string,
      suggestion: f.suggestion as string | undefined,
    }))
  } catch (e) {
    console.error(`[pii] error processing ${file}: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

async function runSemantic(sql: string, file: string, schemaPath?: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.semantics", {
      sql,
      schema_path: schemaPath ?? "",
      schema_context: undefined as any,
    })
    if (result.success && result.data.valid !== false) return []
    const issues = (result.data.issues ?? result.data.findings ?? []) as Array<Record<string, unknown>>
    if (issues.length > 0) {
      return issues.map((f) => ({
        file,
        line: f.line as number | undefined,
        column: f.column as number | undefined,
        code: f.code as string | undefined,
        rule: (f.rule ?? "semantic") as string,
        severity: normalizeSeverity(f.severity as string) || ("warning" as const),
        message: (f.message ?? f.description ?? "") as string,
        suggestion: f.suggestion as string | undefined,
      }))
    }
    if (result.data.valid === false) {
      return [
        {
          file,
          rule: "semantic",
          severity: "warning",
          message: result.error ?? "Semantic check found issues",
        },
      ]
    }
    return []
  } catch (e) {
    console.error(`[semantic] error processing ${file}: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

async function runGrade(sql: string, file: string, schemaPath?: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.grade", {
      sql,
      schema_path: schemaPath ?? "",
      schema_context: undefined as any,
    })
    const issues = (result.data.issues ?? result.data.findings ?? result.data.recommendations ?? []) as Array<
      Record<string, unknown>
    >
    return issues.map((f) => ({
      file,
      line: f.line as number | undefined,
      column: f.column as number | undefined,
      code: f.code as string | undefined,
      rule: (f.rule ?? f.category ?? "grade") as string,
      severity: normalizeSeverity(f.severity as string) || ("info" as const),
      message: (f.message ?? f.description ?? "") as string,
      suggestion: f.suggestion as string | undefined,
    }))
  } catch (e) {
    console.error(`[grade] error processing ${file}: ${e instanceof Error ? e.message : String(e)}`)
    return []
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSeverity(s?: string): Severity {
  if (!s) return "warning"
  const lower = s.toLowerCase()
  if (lower === "error" || lower === "fatal" || lower === "critical") return "error"
  if (lower === "warning" || lower === "warn") return "warning"
  return "info"
}

function filterBySeverity(findings: Finding[], minSeverity: Severity): Finding[] {
  const minRank = SEVERITY_RANK[minSeverity]
  return findings.filter((f) => SEVERITY_RANK[f.severity] >= minRank)
}

function toCategoryResult(findings: Finding[]): CheckCategoryResult {
  return {
    findings,
    error_count: findings.filter((f) => f.severity === "error").length,
    warning_count: findings.filter((f) => f.severity === "warning").length,
  }
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

function formatText(output: CheckOutput): string {
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
// Command
// ---------------------------------------------------------------------------

export const CheckCommand = cmd({
  command: "check [files..]",
  describe: "run deterministic SQL checks (lint, validate, safety, policy, pii — no LLM required)",
  builder: (yargs: Argv) =>
    yargs
      .positional("files", { type: "string", array: true, default: [] as string[] })
      .option("format", {
        describe: "output format",
        choices: ["json", "text"] as const,
        default: "text" as const,
      })
      .option("checks", {
        describe: "comma-separated list of checks to run",
        type: "string",
        default: "lint,safety",
      })
      .option("schema", {
        describe: "path to schema file for validation context",
        type: "string",
      })
      .option("policy", {
        describe: "path to policy JSON file for policy checks",
        type: "string",
      })
      .option("dialect", {
        describe: "SQL dialect (snowflake, bigquery, postgres, etc.)",
        type: "string",
      })
      .option("severity", {
        describe: "minimum severity level to report",
        choices: ["info", "warning", "error"] as const,
        default: "info" as const,
      })
      .option("fail-on", {
        describe: "exit 1 if findings at this level or above are found",
        choices: ["none", "warning", "error"] as const,
        default: "none" as const,
      })
      .option("dbt-project", {
        describe: "path to dbt project directory",
        type: "string",
      })
      .option("manifest", {
        describe: "path to dbt manifest.json",
        type: "string",
      }),

  handler: async (args: {
    files?: string[]
    format?: "json" | "text"
    checks?: string
    schema?: string
    policy?: string
    dialect?: string
    severity?: "info" | "warning" | "error"
    "fail-on"?: "none" | "warning" | "error"
    failOn?: "none" | "warning" | "error"
    "dbt-project"?: string
    manifest?: string
  }) => {
    const startTime = Date.now()

    // 1. Parse checks list
    const checksRaw = (args.checks ?? "lint,safety").split(",").map((c: string) => c.trim().toLowerCase())
    const checks = checksRaw.filter((c: string) => {
      if (!VALID_CHECKS.has(c)) {
        console.error(`Warning: unknown check "${c}", skipping. Valid: ${[...VALID_CHECKS].join(", ")}`)
        return false
      }
      return true
    })
    if (checks.length === 0) {
      console.error("Error: no valid checks specified.")
      process.exit(1)
    }

    // 2. Validate policy requirement
    if (checks.includes("policy")) {
      if (!args.policy) {
        console.error("Error: --policy is required when running the policy check.")
        process.exit(1)
      }
      if (!existsSync(args.policy)) {
        console.error(`Error: policy file not found: ${args.policy}`)
        process.exit(1)
      }
    }

    // 3. Resolve files
    let files: string[] = args.files ?? []
    if (files.length === 0) {
      console.error("No files specified, searching for **/*.sql in current directory...")
      files = await Glob.scan("**/*.sql", { cwd: process.cwd(), absolute: true })
    } else {
      // Expand globs in positional args
      const expanded: string[] = []
      for (const pattern of files) {
        if (pattern.includes("*") || pattern.includes("?")) {
          const matches = await Glob.scan(pattern, { cwd: process.cwd(), absolute: true })
          expanded.push(...matches)
        } else {
          expanded.push(path.resolve(process.cwd(), pattern))
        }
      }
      files = expanded
    }

    // Filter to only existing .sql files
    files = files.filter((f) => {
      if (!existsSync(f)) {
        console.error(`Warning: file not found, skipping: ${f}`)
        return false
      }
      return true
    })

    if (files.length === 0) {
      console.error("No SQL files found to check.")
      process.exit(0)
    }

    console.error(`Found ${files.length} SQL file(s) to check with [${checks.join(", ")}]`)

    // 4. Load schema and policy if provided
    const schemaPath = args.schema && existsSync(args.schema) ? args.schema : undefined
    let policyJson = ""
    if (args.policy && existsSync(args.policy)) {
      try {
        policyJson = readFileSync(args.policy, "utf-8")
      } catch (e) {
        console.error(`Error reading policy file: ${e instanceof Error ? e.message : String(e)}`)
        process.exit(1)
      }
    }

    // 5. Run checks on all files in batches of 10
    const BATCH_SIZE = 10
    const allResults: Record<string, Finding[]> = {}
    for (const check of checks) {
      allResults[check] = []
    }

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE)
      const batchPromises = batch.map(async (file) => {
        let sql: string
        try {
          sql = readFileSync(file, "utf-8")
        } catch (e) {
          console.error(`Error reading ${file}: ${e instanceof Error ? e.message : String(e)}`)
          return
        }
        if (!sql.trim()) return

        const relFile = path.relative(process.cwd(), file)

        for (const check of checks) {
          let findings: Finding[] = []
          switch (check) {
            case "lint":
              findings = await runLint(sql, relFile, schemaPath)
              break
            case "validate":
              findings = await runValidate(sql, relFile, schemaPath)
              break
            case "safety":
              findings = await runSafety(sql, relFile)
              break
            case "policy":
              findings = await runPolicy(sql, relFile, policyJson, schemaPath)
              break
            case "pii":
              findings = await runPii(sql, relFile, schemaPath)
              break
            case "semantic":
              findings = await runSemantic(sql, relFile, schemaPath)
              break
            case "grade":
              findings = await runGrade(sql, relFile, schemaPath)
              break
          }
          allResults[check].push(...findings)
        }
      })
      await Promise.all(batchPromises)
    }

    // 6. Filter by severity
    const minSeverity = args.severity as Severity
    const results: Record<string, CheckCategoryResult> = {}
    for (const [check, findings] of Object.entries(allResults)) {
      results[check] = toCategoryResult(filterBySeverity(findings, minSeverity))
    }

    // 7. Build output
    const allFindings = Object.values(results).flatMap((r) => r.findings)
    const errors = allFindings.filter((f) => f.severity === "error").length
    const warnings = allFindings.filter((f) => f.severity === "warning").length
    const info = allFindings.filter((f) => f.severity === "info").length

    const failOn = args["fail-on"] ?? args.failOn ?? "none"
    let pass = true
    if (failOn === "error" && errors > 0) pass = false
    if (failOn === "warning" && (errors > 0 || warnings > 0)) pass = false

    const output: CheckOutput = {
      version: 1,
      files_checked: files.length,
      checks_run: checks,
      schema_resolved: schemaPath !== undefined,
      results,
      summary: {
        total_findings: allFindings.length,
        errors,
        warnings,
        info,
        pass,
      },
    }

    // 8. Output
    const duration = Date.now() - startTime
    if (args.format === "json") {
      process.stdout.write(JSON.stringify(output, null, 2) + "\n")
    } else {
      console.error(formatText(output))
    }
    console.error(`Completed in ${duration}ms`)

    // 9. Exit code
    if (!pass) {
      process.exit(1)
    }
  },
})
// altimate_change end
