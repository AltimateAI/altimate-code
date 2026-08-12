import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { Telemetry } from "../telemetry"

export const AltimateCorePolicyTool = Tool.define("altimate_core_policy", {
  description:
    "Check SQL against YAML-based governance policy guardrails. Validates compliance with custom rules like allowed tables, forbidden operations, and data access restrictions. Provide schema_context or schema_path for accurate table/column resolution.",
  parameters: z.object({
    sql: z.string().describe("SQL query to check against policy"),
    policy_json: z.string().describe("JSON string defining the policy rules"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    const hasSchema = !!(args.schema_path || (args.schema_context && Object.keys(args.schema_context).length > 0))
    try {
      const result = await Dispatcher.call("altimate_core.policy", {
        sql: args.sql,
        policy_json: args.policy_json,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = (result.data ?? {}) as Record<string, any>
      const error = result.error ?? data.error
      // altimate_change start — sql quality findings for telemetry
      const violations = Array.isArray(data.violations) ? data.violations : []
      const findings: Telemetry.Finding[] = violations.map((v: any) => ({
        category: v.rule ?? "policy_violation",
      }))
      // altimate_change end
      // Engine PolicyResult: { allowed, violations, warnings, … } — `pass`
      // never existed, so every clean query used to render VIOLATIONS FOUND.
      const allowed = (data.allowed ?? data.pass) as boolean | undefined
      return {
        title: error ? "Policy: ERROR" : `Policy: ${allowed ? "PASS" : "VIOLATIONS FOUND"}`,
        metadata: {
          // Violations are findings, not failures — but a failed engine call
          // (e.g. malformed policy JSON) must not report success.
          success: result.success,
          pass: allowed,
          has_schema: hasSchema,
          ...(error && { error }),
          ...(findings.length > 0 && { findings }),
        },
        output: error ? `Error: ${error}` : formatPolicy(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Policy: ERROR",
        metadata: { success: false, pass: false, has_schema: hasSchema, error: msg },
        output: `Failed: ${msg}`,
      }
    }
  },
})

function formatPolicy(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.allowed ?? data.pass) {
    // allowed:true can still carry warnings — surface them with the pass.
    const warnings = (data.warnings ?? []) as any[]
    if (!warnings.length) return "SQL passes all policy checks."
    const lines = ["SQL passes all policy checks, with warnings:\n"]
    for (const w of warnings) {
      lines.push(`  [warning] ${w.rule ?? "policy"}: ${w.message ?? ""}`)
    }
    return lines.join("\n")
  }
  const lines = ["Policy violations:\n"]
  for (const v of data.violations ?? []) {
    lines.push(`  [${v.severity ?? "error"}] ${v.rule}: ${v.message}`)
  }
  return lines.join("\n")
}
