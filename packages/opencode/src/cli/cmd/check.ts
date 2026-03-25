// altimate_change start — check: deterministic SQL check CLI command (no LLM required)
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Dispatcher } from "../../altimate/native"
import { readFileSync, existsSync } from "fs"
import { Glob } from "../../util/glob"
import path from "path"
import {
  type Finding,
  type CheckCategoryResult,
  type Severity,
  VALID_CHECKS,
  normalizeSeverity,
  filterBySeverity,
  toCategoryResult,
  formatText,
  buildCheckOutput,
} from "./check-helpers"

// ---------------------------------------------------------------------------
// Check runners — each calls Dispatcher.call() and normalizes to Finding[]
// On Dispatcher failure, emit an error-severity finding so CI doesn't false-pass.
// ---------------------------------------------------------------------------

function dispatcherErrorFinding(check: string, file: string, e: unknown): Finding {
  return {
    file,
    rule: `${check}-error`,
    severity: "error",
    message: `[${check}] check failed: ${e instanceof Error ? e.message : String(e)}`,
  }
}

async function runLint(sql: string, file: string, schemaPath?: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.lint", {
      sql,
      schema_path: schemaPath ?? "",
    })
    if (!result.success) {
      return [dispatcherErrorFinding("lint", file, result.error ?? "altimate_core.lint failed")]
    }
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
    return [dispatcherErrorFinding("lint", file, e)]
  }
}

async function runValidate(sql: string, file: string, schemaPath?: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.validate", {
      sql,
      schema_path: schemaPath ?? "",
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
        severity: normalizeSeverity(f.severity as string),
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
    return [dispatcherErrorFinding("validate", file, e)]
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
        severity: normalizeSeverity(f.severity as string),
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
    return [dispatcherErrorFinding("safety", file, e)]
  }
}

async function runPolicy(sql: string, file: string, policyJson: string, schemaPath?: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.policy", {
      sql,
      policy_json: policyJson,
      schema_path: schemaPath ?? "",
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
        severity: normalizeSeverity(f.severity as string),
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
    return [dispatcherErrorFinding("policy", file, e)]
  }
}

async function runPii(sql: string, file: string, schemaPath?: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.query_pii", {
      sql,
      schema_path: schemaPath ?? "",
    })
    if (!result.success) {
      return [dispatcherErrorFinding("pii", file, result.error ?? "altimate_core.query_pii failed")]
    }
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
    return [dispatcherErrorFinding("pii", file, e)]
  }
}

async function runSemantic(sql: string, file: string, schemaPath?: string): Promise<Finding[]> {
  try {
    const result = await Dispatcher.call("altimate_core.semantics", {
      sql,
      schema_path: schemaPath ?? "",
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
        severity: normalizeSeverity(f.severity as string),
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
    return [dispatcherErrorFinding("semantic", file, e)]
  }
}

async function runGrade(
  sql: string,
  file: string,
  schemaPath?: string,
): Promise<{ findings: Finding[]; grade?: string; score?: number }> {
  try {
    const result = await Dispatcher.call("altimate_core.grade", {
      sql,
      schema_path: schemaPath ?? "",
    })
    const issues = (result.data.issues ?? result.data.findings ?? result.data.recommendations ?? []) as Array<
      Record<string, unknown>
    >
    const findings = issues.map((f) => ({
      file,
      line: f.line as number | undefined,
      column: f.column as number | undefined,
      code: f.code as string | undefined,
      rule: (f.rule ?? f.category ?? "grade") as string,
      severity: normalizeSeverity(f.severity as string),
      message: (f.message ?? f.description ?? "") as string,
      suggestion: f.suggestion as string | undefined,
    }))
    // Preserve the primary A-F grade value from the backend
    const grade = (result.data.grade ?? result.data.letter_grade) as string | undefined
    const score = (result.data.score ?? result.data.numeric_score) as number | undefined
    return { findings, grade, score }
  } catch (e) {
    console.error(`[grade] error processing ${file}: ${e instanceof Error ? e.message : String(e)}`)
    return { findings: [dispatcherErrorFinding("grade", file, e)] }
  }
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
      .option("severity", {
        describe: "minimum severity level to report",
        choices: ["info", "warning", "error"] as const,
        default: "info" as const,
      })
      .option("fail-on", {
        describe: "exit 1 if findings at this level or above are found",
        choices: ["none", "warning", "error"] as const,
        default: "none" as const,
      }),

  handler: async (args: {
    files?: string[]
    format?: "json" | "text"
    checks?: string
    schema?: string
    policy?: string
    severity?: "info" | "warning" | "error"
    "fail-on"?: "none" | "warning" | "error"
    failOn?: "none" | "warning" | "error"
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
      process.exitCode = 1
      return
    }

    // 2. Validate policy requirement
    if (checks.includes("policy")) {
      if (!args.policy) {
        console.error("Error: --policy is required when running the policy check.")
        process.exitCode = 1
        return
      }
      if (!existsSync(args.policy)) {
        console.error(`Error: policy file not found: ${args.policy}`)
        process.exitCode = 1
        return
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
      return
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
        process.exitCode = 1
        return
      }
    }

    // 5. Run checks on all files in batches of 10
    const BATCH_SIZE = 10
    const allResults: Record<string, Finding[]> = {}
    let gradeValue: string | undefined
    let gradeScore: number | undefined
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
            case "grade": {
              const gradeResult = await runGrade(sql, relFile, schemaPath)
              findings = gradeResult.findings
              if (gradeResult.grade) gradeValue = gradeResult.grade
              if (gradeResult.score != null) gradeScore = gradeResult.score
              break
            }
          }
          allResults[check].push(...findings)
        }
      })
      await Promise.all(batchPromises)
    }

    // 6. Compute pass/fail on UNFILTERED findings (before severity filtering)
    // This ensures --severity only controls output display, not exit code logic.
    const failOn = args["fail-on"] ?? args.failOn ?? "none"
    const allUnfiltered = Object.values(allResults).flat()
    const unfilteredErrors = allUnfiltered.filter((f) => f.severity === "error").length
    const unfilteredWarnings = allUnfiltered.filter((f) => f.severity === "warning").length
    let pass = true
    if (failOn === "error" && unfilteredErrors > 0) pass = false
    if (failOn === "warning" && (unfilteredErrors > 0 || unfilteredWarnings > 0)) pass = false

    // 7. Filter by severity for display
    const minSeverity = args.severity as Severity
    const results: Record<string, CheckCategoryResult> = {}
    for (const [check, findings] of Object.entries(allResults)) {
      results[check] = toCategoryResult(filterBySeverity(findings, minSeverity))
    }

    // 8. Attach grade metadata if available
    if (results.grade) {
      if (gradeValue) results.grade.grade = gradeValue
      if (gradeScore != null) results.grade.score = gradeScore
    }

    // 9. Build output using the helper
    const output = buildCheckOutput({
      filesChecked: files.length,
      checksRun: checks,
      schemaResolved: schemaPath !== undefined,
      results,
      failOn: "none", // pass is already computed above from unfiltered findings
    })
    // Override pass with our pre-computed value from unfiltered findings
    output.summary.pass = pass

    // 10. Output
    const duration = Date.now() - startTime
    if (args.format === "json") {
      process.stdout.write(JSON.stringify(output, null, 2) + "\n")
    } else {
      console.error(formatText(output))
    }
    console.error(`Completed in ${duration}ms`)

    // 11. Exit code — use process.exitCode instead of process.exit() to allow
    // the outer finally block in index.ts to run Telemetry.shutdown().
    if (!pass) {
      process.exitCode = 1
    }
  },
})
// altimate_change end
