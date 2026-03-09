import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreSafetyTool = Tool.define("altimate_core_safety", {
  description:
    "Scan SQL for injection patterns, dangerous statements (DROP, TRUNCATE), and security threats. Uses the Rust-based altimate-core safety engine.",
  parameters: z.object({
    sql: z.string().describe("SQL query to scan"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.safety", { sql: args.sql })
      const data = result.data as Record<string, any>
      return {
        title: `Safety: ${data.safe ? "SAFE" : `${data.threats?.length ?? 0} threats`}`,
        metadata: { success: result.success, safe: data.safe, riskScore: data.risk_score },
        output: formatSafety(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Safety: ERROR", metadata: { success: false, safe: false, riskScore: undefined }, output: `Failed: ${msg}` }
    }
  },
})

function formatSafety(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.safe) return "Query is safe — no threats detected."

  const lines = [`Risk score: ${data.risk_score}\n`, "Threats detected:\n"]
  for (const t of data.threats ?? []) {
    lines.push(`  [${t.severity}] ${t.type}: ${t.description}`)
    lines.push(`    at line ${t.location?.line ?? "?"}, col ${t.location?.column ?? "?"}`)
    lines.push("")
  }
  return lines.join("\n")
}
