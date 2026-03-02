import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import type { CostGateResult, CostGateFileResult } from "../bridge/protocol"

export const CiCostGateTool = Tool.define("ci_cost_gate", {
  description:
    "Scan changed SQL files for critical issues. Reads SQL files, runs analysis and guard checks, and returns pass/fail based on whether critical severity issues are found. Skips Jinja templates, parse errors, and non-SQL files. Exit code 1 if critical issues found, 0 otherwise.",
  parameters: z.object({
    file_paths: z.array(z.string()).describe("List of SQL file paths to scan"),
    dialect: z
      .string()
      .optional()
      .default("snowflake")
      .describe("SQL dialect (snowflake, postgres, bigquery, duckdb, etc.)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("ci.cost_gate", {
        file_paths: args.file_paths,
        dialect: args.dialect,
      })

      const status = result.passed ? "PASSED" : "FAILED"

      return {
        title: `CI Scan: ${status} (${result.files_scanned} files, ${result.total_issues} issues, ${result.critical_count} critical)`,
        metadata: {
          success: result.success,
          passed: result.passed,
          exitCode: result.exit_code,
          filesScanned: result.files_scanned,
          totalIssues: result.total_issues,
          criticalCount: result.critical_count,
        },
        output: formatCostGate(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "CI Scan: ERROR",
        metadata: { success: false, passed: false, exitCode: 1, filesScanned: 0, totalIssues: 0, criticalCount: 0 },
        output: `Failed to run CI scan: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})

function formatCostGate(result: CostGateResult): string {
  if (!result.success) {
    return `CI scan failed: ${result.error ?? "Unknown error"}`
  }

  const lines: string[] = []
  const status = result.passed ? "PASSED" : "FAILED"

  lines.push(`=== CI Cost Gate: ${status} ===`)
  lines.push(`Files scanned: ${result.files_scanned} | Skipped: ${result.files_skipped}`)
  lines.push(`Total issues: ${result.total_issues} | Critical: ${result.critical_count}`)
  lines.push(`Exit code: ${result.exit_code}`)
  lines.push("")

  for (const fr of result.file_results) {
    const icon = fr.status === "pass" ? "OK" : fr.status === "fail" ? "FAIL" : "SKIP"
    lines.push(`  [${icon}] ${fr.file}`)

    if (fr.reason) {
      lines.push(`    Reason: ${fr.reason}`)
    }

    if (fr.issues.length > 0) {
      for (const issue of fr.issues) {
        const severity = ((issue.severity as string) ?? "warning").toUpperCase()
        lines.push(`    [${severity}] ${issue.type}: ${issue.message}`)
      }
    }
  }

  return lines.join("\n")
}
