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

/** Render an engine [byteOffset, byteLength] tuple as an inclusive byte range. */
function byteRange(loc: unknown): string {
  if (!Array.isArray(loc) || loc.length < 2) return ""
  const [start, len] = loc as [number, number]
  return ` (bytes ${start}-${start + Math.max(len - 1, 0)})`
}

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
    // The handler returns success=true even for invalid SQL — the verdict
    // lives in data.valid (engine ValidationResult). Gating on success alone
    // made this check pass every file.
    if (result.success && result.data.valid !== false) return []
    const errors = (result.data.errors ?? result.data.findings ?? []) as Array<Record<string, unknown>>
    if (errors.length > 0) {
      return errors.map((f) => {
        // Engine ValidationError: { code, kind, message, location: {line, column} | null, suggestions }
        const location = f.location as { line?: number; column?: number } | null | undefined
        const s0 = (f.suggestions as unknown[] | undefined)?.[0]
        const engineSuggestion = typeof s0 === "string" ? s0 : ((s0 as Record<string, unknown> | undefined)?.message as string | undefined)
        return {
          file,
          line: (location?.line ?? f.line) as number | undefined,
          column: (location?.column ?? f.column) as number | undefined,
          code: f.code as string | undefined,
          rule: "validate",
          severity: "error" as const,
          message: (f.message ?? f.description ?? "") as string,
          suggestion: (f.suggestion ?? engineSuggestion) as string | undefined,
        }
      })
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
    const issues = (result.data.threats ??
      result.data.issues ??
      result.data.findings ??
      []) as Array<Record<string, unknown>>
    const mapped = issues.map((f) => ({
      file,
      rule: (f.rule ?? f.category ?? "safety") as string,
      severity: normalizeSeverity(f.severity as string),
      // ThreatFinding.location is [byteOffset, byteLength] — labeled as bytes
      // (offsets diverge from char indexes on multibyte SQL), inclusive end.
      // ThreatFinding carries no line/column/code fields.
      message: `${(f.message ?? f.description ?? "") as string}${byteRange(f.location)}`,
      suggestion: (f.suggestion ?? f.detail) as string | undefined,
    }))
    if (!result.success) {
      // Fail closed like every other check — a crashed safety engine must not
      // pass --fail-on error, even when partial threats were returned and none
      // of them is error-severity.
      return [...mapped, dispatcherErrorFinding("safety", file, result.error ?? "altimate_core.safety failed")]
    }
    if (mapped.length > 0) {
      return mapped
    }
    if (result.data.safe === false) {
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
    // allowed:true can still carry advisory warnings — surface them as info.
    const warningFindings = ((result.data.warnings ?? []) as Array<Record<string, unknown>>).map((w) => ({
      file,
      rule: (w.rule ?? "policy") as string,
      severity: "info" as const,
      message: (w.message ?? "") as string,
    }))
    if (result.success && result.data.allowed !== false) return warningFindings
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
        // PolicyViolation carries its fix hint as `remediation`.
        suggestion: (f.suggestion ?? f.remediation) as string | undefined,
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
    // The engine reports unparseable SQL via data.parse_error with an empty
    // pii_columns list — an abstention. Returning no findings would let
    // `--fail-on` PASS a file whose PII analysis never ran.
    if (result.data.parse_error) {
      return [dispatcherErrorFinding("pii", file, `PII analysis skipped: ${result.data.parse_error}`)]
    }
    // Engine shape (PiiColumnAccess): table, column, classification,
    // query_targets, suggested_masking. `column` is the column NAME — not a
    // position — so it must not populate the numeric location field.
    const piiFindings = (result.data.pii_columns ?? result.data.findings ?? []) as Array<Record<string, unknown>>
    return piiFindings.map((f) => {
      const qualified = [f.table, f.column].filter(Boolean).join(".")
      const targets = Array.isArray(f.query_targets) && f.query_targets.length ? ` (exposed via: ${(f.query_targets as string[]).join(", ")})` : ""
      // Classification is a string OR { Custom: string }.
      const classification = f.classification as string | { Custom: string } | undefined
      const rule =
        typeof classification === "string"
          ? classification
          : (classification?.Custom ?? (f.category as string) ?? (f.pii_type as string) ?? "pii")
      return {
        file,
        line: f.line as number | undefined,
        code: f.code as string | undefined,
        rule,
        severity: "warning" as const,
        // Machine-readable column NAME (the engine's `column` is a name, not a
        // position, so it must not populate the numeric `column` field).
        columnName: f.column as string | undefined,
        message: (f.message ?? f.description ?? `PII detected: ${qualified || "unknown"}${targets}`) as string,
        // suggested_masking is string | null — never emit null as a suggestion.
        suggestion: (f.suggestion ?? f.suggested_masking ?? undefined) as string | undefined,
      }
    })
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
    // Engine SemanticResult reports findings under `findings` and can return
    // valid:true WITH findings (e.g. cartesian product) — `valid` means
    // "plannable", not "clean". Never gate findings on it.
    const issues = (result.data.findings ?? result.data.issues ?? []) as Array<Record<string, unknown>>
    // Fail closed on engine failure, but only when there are no structured
    // findings to surface.
    if (!result.success && issues.length === 0) {
      return [dispatcherErrorFinding("semantic", file, result.error ?? "altimate_core.semantics failed")]
    }
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
      // SemanticResult.validation_errors carries the reason the query is
      // unplannable — surface it instead of a bare generic message. With a
      // schema supplied this is an abstention that must fail closed (error);
      // schema-less runs abstain routinely, so only warn there.
      const detail = (result.data.validation_errors as unknown[] | undefined)
        ?.map((e) => (typeof e === "string" ? e : ((e as Record<string, unknown>)?.message ?? String(e))))
        .filter(Boolean)
        .join("; ")
      return [
        {
          file,
          rule: "semantic",
          severity: schemaPath ? ("error" as const) : ("warning" as const),
          message: (result.error ?? detail) || "Semantic check found issues",
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
    // Native handlers report failures via the envelope (success:false), not by
    // throwing — fail closed instead of emitting a passing empty grade.
    if (!result.success) {
      return { findings: [dispatcherErrorFinding("grade", file, result.error ?? "altimate_core.grade failed")] }
    }
    // Engine EvalResult: { explain, lint, overall_grade, safety, scores, sql,
    // total_time_ms, validation } — the grade is `overall_grade`, the numeric
    // score is `scores.overall`. Findings come from ALL nested sections:
    // lint.findings, validation.errors, and safety.threats — a failing grade
    // with clean lint must not produce an empty (passing) finding list.
    const lint = result.data.lint as Record<string, unknown> | undefined
    const validation = result.data.validation as Record<string, unknown> | undefined
    const safety = result.data.safety as Record<string, unknown> | undefined
    // Normalize each section's location/suggestion shape to the flat fields
    // the shared mapper below reads — otherwise nested findings drop the line
    // numbers and fixes that runValidate/runSafety already surface.
    const nested = [
      ...((lint?.findings as Array<Record<string, unknown>> | undefined) ?? []),
      ...(((validation?.errors as Array<Record<string, unknown>> | undefined) ?? []).map((e) => {
        // ValidationError: location {line, column} | null, suggestions[]
        const location = e.location as { line?: number; column?: number } | null | undefined
        const s0 = (e.suggestions as unknown[] | undefined)?.[0]
        return {
          ...e,
          rule: "validate",
          severity: "error",
          line: location?.line ?? e.line,
          column: location?.column ?? e.column,
          suggestion: e.suggestion ?? (typeof s0 === "string" ? s0 : (s0 as Record<string, unknown> | undefined)?.message),
        }
      }) as Array<Record<string, unknown>>),
      ...(((safety?.threats as Array<Record<string, unknown>> | undefined) ?? []).map((t) => {
        // ThreatFinding: location is [byteOffset, byteLength]; detail is the fix hint
        return {
          ...t,
          rule: (t.rule as string) ?? "safety",
          message: `${(t.message ?? "") as string}${byteRange(t.location)}`,
          location: undefined,
          suggestion: t.suggestion ?? t.detail,
        }
      }) as Array<Record<string, unknown>>),
    ]
    const issues = (result.data.issues ??
      result.data.findings ??
      result.data.recommendations ??
      (nested.length ? nested : undefined) ??
      []) as Array<Record<string, unknown>>
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
    const grade = (result.data.overall_grade ?? result.data.grade ?? result.data.letter_grade) as string | undefined
    const scores = result.data.scores as Record<string, unknown> | undefined
    const score = (scores?.overall ?? result.data.score ?? result.data.numeric_score) as number | undefined
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
    // Per-file grades — concurrent batch promises must not race on a single
    // shared grade (multi-file runs used to keep whichever file finished last).
    const gradesByFile: Record<string, { grade?: string; score?: number }> = {}
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
              if (gradeResult.grade || gradeResult.score != null) {
                gradesByFile[relFile] = { grade: gradeResult.grade, score: gradeResult.score }
              }
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
      const graded = Object.entries(gradesByFile)
      if (graded.length) results.grade.grades = gradesByFile
      // Flat grade/score only for single-file INVOCATIONS — gating on how many
      // grades survived would misattribute when one of several files errored.
      if (files.length === 1 && graded.length === 1) {
        const [, only] = graded[0]
        if (only.grade) results.grade.grade = only.grade
        if (only.score != null) results.grade.score = only.score
      }
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
