import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const AltimateCorePolicyTool = Tool.define("altimate_core_policy", {
  description:
    "Check SQL against YAML-based governance policy guardrails using the Rust-based altimate-core engine. Validates compliance with custom rules like allowed tables, forbidden operations, and data access restrictions.",
  parameters: z.object({
    sql: z.string().describe("SQL query to check against policy"),
    policy_json: z.string().describe("JSON string defining the policy rules"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.policy", {
        sql: args.sql,
        policy_json: args.policy_json,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Policy: ${data.pass ? "PASS" : "VIOLATIONS FOUND"}`,
        metadata: { success: result.success, pass: data.pass },
        output: formatPolicy(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Policy: ERROR", metadata: { success: false, pass: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatPolicy(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.pass) return "SQL passes all policy checks."
  const lines = ["Policy violations:\n"]
  for (const v of data.violations ?? []) {
    lines.push(`  [${v.severity ?? "error"}] ${v.rule}: ${v.message}`)
  }
  return lines.join("\n")
}
