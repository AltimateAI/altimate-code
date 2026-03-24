import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { Telemetry } from "../telemetry"

export const AltimateCoreFixTool = Tool.define("altimate_core_fix", {
  description:
    "Auto-fix SQL errors using fuzzy matching and iterative re-validation. Corrects syntax errors, typos, and schema reference issues. IMPORTANT: Provide schema_context or schema_path — without schema, table/column references cannot be resolved or fixed.",
  parameters: z.object({
    sql: z.string().describe("SQL query to fix"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
    max_iterations: z.number().optional().describe("Maximum fix iterations (default: 5)"),
  }),
  async execute(args, ctx) {
    const hasSchema = !!(args.schema_path || (args.schema_context && Object.keys(args.schema_context).length > 0))
    try {
      const result = await Dispatcher.call("altimate_core.fix", {
        sql: args.sql,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
        max_iterations: args.max_iterations ?? 5,
      })
      const data = (result.data ?? {}) as Record<string, any>
      const error = result.error ?? data.error ?? extractFixErrors(data)
      // post_fix_valid=true with no errors means SQL was already valid (nothing to fix)
      const alreadyValid = data.post_fix_valid && !error
      const success = result.success || alreadyValid
      // altimate_change start — sql quality findings for telemetry
      const findings: Telemetry.Finding[] = []
      for (const fix of data.fixes_applied ?? data.changes ?? []) {
        findings.push({ category: "fix_applied" })
      }
      for (const err of data.unfixable_errors ?? []) {
        findings.push({ category: "unfixable_error" })
      }
      // altimate_change end
      return {
        title: `Fix: ${alreadyValid ? "ALREADY VALID" : data.fixed ? "FIXED" : "COULD NOT FIX"}`,
        metadata: {
          success,
          fixed: !!data.fixed_sql,
          has_schema: hasSchema,
          ...(error && { error }),
          ...(findings.length > 0 && { findings }),
        },
        output: formatFix(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Fix: ERROR", metadata: { success: false, fixed: false, has_schema: hasSchema, error: msg }, output: `Failed: ${msg}` }
    }
  },
})

// Safety net: the native handler (register.ts) also extracts unfixable_errors into
// result.error, but we extract here too in case the handler is updated without setting it.
function extractFixErrors(data: Record<string, any>): string | undefined {
  if (Array.isArray(data.unfixable_errors) && data.unfixable_errors.length > 0) {
    const msgs = data.unfixable_errors.map((e: any) => e.error?.message ?? e.reason ?? String(e)).filter(Boolean)
    if (msgs.length > 0) return msgs.join("; ")
  }
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const msgs = data.errors.map((e: any) => e.message ?? String(e)).filter(Boolean)
    if (msgs.length > 0) return msgs.join("; ")
  }
  return undefined
}

function formatFix(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const lines: string[] = []
  if (data.fixed_sql && data.fixed !== false) {
    lines.push("Fixed SQL:")
    lines.push(data.fixed_sql)
    const fixes = data.fixes_applied ?? data.changes ?? []
    if (fixes.length) {
      lines.push("\nChanges applied:")
      for (const c of fixes) {
        lines.push(`  - ${c.description ?? c.message ?? c}`)
      }
    }
  } else {
    lines.push("Could not auto-fix the SQL.")
    const unfixable = data.unfixable_errors ?? data.errors ?? []
    if (unfixable.length) {
      lines.push("\nErrors found:")
      for (const e of unfixable) {
        lines.push(`  - ${e.message ?? e.reason ?? e}`)
      }
    }
  }
  return lines.join("\n")
}
