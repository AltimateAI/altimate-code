import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import type { SqlPreprocessJinjaResult } from "../bridge/protocol"

export const SqlPreprocessJinjaTool = Tool.define("sql_preprocess_jinja", {
  description:
    "Preprocess Jinja/dbt template syntax in SQL before analysis. Stubs common dbt macros like {{ ref() }}, {{ source() }}, {{ config() }}, {{ var() }}, {{ this }}, and Jinja block tags ({% if %}, {% for %}) into plain SQL that downstream tools can parse. Use this when SQL analysis tools fail on dbt-templated SQL.",
  parameters: z.object({
    sql: z.string().describe("SQL with Jinja/dbt template syntax to preprocess"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sql.preprocess_jinja", {
        sql: args.sql,
      })

      if (!result.was_preprocessed) {
        return {
          title: "Preprocess Jinja: no templates found",
          metadata: {
            success: true as boolean,
            was_preprocessed: false as boolean,
            refs: [] as string[],
            sources: [] as string[],
            variables: [] as string[],
          },
          output: "No Jinja templates detected in the SQL. The input is already plain SQL.",
        }
      }

      return {
        title: `Preprocess Jinja: ${formatSummary(result)}`,
        metadata: {
          success: result.success,
          was_preprocessed: result.was_preprocessed,
          refs: result.refs_found,
          sources: result.sources_found,
          variables: result.variables_found,
        },
        output: formatResult(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Preprocess Jinja: ERROR",
        metadata: {
          success: false as boolean,
          was_preprocessed: false as boolean,
          refs: [] as string[],
          sources: [] as string[],
          variables: [] as string[],
        },
        output: `Failed to preprocess Jinja: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})

function formatSummary(result: SqlPreprocessJinjaResult): string {
  const parts: string[] = []
  if (result.refs_found.length > 0) parts.push(`${result.refs_found.length} ref(s)`)
  if (result.sources_found.length > 0) parts.push(`${result.sources_found.length} source(s)`)
  if (result.variables_found.length > 0) parts.push(`${result.variables_found.length} var(s)`)
  return parts.length > 0 ? parts.join(", ") : "templates removed"
}

function formatResult(result: SqlPreprocessJinjaResult): string {
  const lines: string[] = []

  lines.push("=== Preprocessed SQL ===")
  lines.push(result.preprocessed_sql)
  lines.push("")

  if (result.refs_found.length > 0) {
    lines.push(`Models referenced (ref): ${result.refs_found.join(", ")}`)
  }
  if (result.sources_found.length > 0) {
    lines.push(`Sources referenced: ${result.sources_found.join(", ")}`)
  }
  if (result.variables_found.length > 0) {
    lines.push(`Variables used (var): ${result.variables_found.join(", ")}`)
  }
  if (result.macros_removed.length > 0) {
    lines.push(`Macros removed: ${result.macros_removed.join(", ")}`)
  }

  if (result.warnings.length > 0) {
    lines.push("")
    lines.push("=== Warnings ===")
    for (const w of result.warnings) {
      lines.push(`  ! ${w}`)
    }
  }

  lines.push("")
  lines.push(
    "Note: Jinja templates were stubbed with placeholder values. " +
      "Analysis results on this SQL are approximate.",
  )

  return lines.join("\n")
}
