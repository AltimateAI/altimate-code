import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlValidateTool = Tool.define("sql_validate", {
  description:
    "Validate SQL syntax and check for safety issues. Detects DML/DDL statements and enforces read-only mode when specified.",
  parameters: z.object({
    sql: z.string().describe("SQL to validate"),
    mode: z
      .enum(["full", "read-only"])
      .optional()
      .default("full")
      .describe("Validation mode. read-only rejects non-SELECT statements."),
    dialect: z.string().optional().describe("SQL dialect (postgres, snowflake, bigquery, etc.)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sql.check", {
        sql: args.sql,
        mode: args.mode,
        dialect: args.dialect,
      })

      const lines: string[] = []
      if (result.safe) {
        lines.push("SQL is valid and safe.")
      } else {
        lines.push("SQL validation found issues:")
      }

      for (const issue of result.issues) {
        const loc = issue.line ? ` (line ${issue.line}${issue.column ? `:${issue.column}` : ""})` : ""
        lines.push(`  [${issue.severity.toUpperCase()}] ${issue.code}: ${issue.message}${loc}`)
      }

      return {
        title: `Validate: ${result.safe ? "PASS" : "FAIL"} (${result.issues.length} issues)`,
        metadata: { safe: result.safe, issueCount: result.issues.length },
        output: lines.join("\n"),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Validate: ERROR",
        metadata: { safe: false, issueCount: 0 },
        output: `Failed to validate SQL: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})
