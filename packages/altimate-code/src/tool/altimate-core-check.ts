import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreCheckTool = Tool.define("altimate_core_check", {
  description:
    "Run full analysis pipeline: validate + lint + safety scan + PII check using the Rust-based altimate-core engine. Single call for comprehensive SQL analysis.",
  parameters: z.object({
    sql: z.string().describe("SQL query to analyze"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.check", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Check: ${formatCheckTitle(data)}`,
        metadata: { success: result.success },
        output: formatCheck(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Check: ERROR", metadata: { success: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatCheckTitle(data: Record<string, any>): string {
  const parts: string[] = []
  if (!data.validation?.valid) parts.push("validation errors")
  if (!data.lint?.clean) parts.push(`${data.lint?.findings?.length ?? 0} lint findings`)
  if (!data.safety?.safe) parts.push("safety threats")
  if (data.pii?.findings?.length) parts.push("PII detected")
  return parts.length ? parts.join(", ") : "PASS"
}

function formatCheck(data: Record<string, any>): string {
  const lines: string[] = []

  lines.push("=== Validation ===")
  if (data.validation?.valid) {
    lines.push("Valid SQL.")
  } else {
    lines.push(`Invalid: ${data.validation?.errors?.map((e: any) => e.message).join("; ") ?? "unknown"}`)
  }

  lines.push("\n=== Lint ===")
  if (data.lint?.clean) {
    lines.push("No lint findings.")
  } else {
    for (const f of data.lint?.findings ?? []) {
      lines.push(`  [${f.severity}] ${f.rule}: ${f.message}`)
    }
  }

  lines.push("\n=== Safety ===")
  if (data.safety?.safe) {
    lines.push("Safe — no threats.")
  } else {
    for (const t of data.safety?.threats ?? []) {
      lines.push(`  [${t.severity}] ${t.type}: ${t.description}`)
    }
  }

  lines.push("\n=== PII ===")
  if (!data.pii?.findings?.length) {
    lines.push("No PII detected.")
  } else {
    for (const p of data.pii?.findings ?? []) {
      lines.push(`  ${p.column}: ${p.category} (${p.confidence} confidence)`)
    }
  }

  return lines.join("\n")
}
