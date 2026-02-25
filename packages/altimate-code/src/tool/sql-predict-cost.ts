import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import type { SqlPredictCostResult } from "../bridge/protocol"

export const SqlPredictCostTool = Tool.define("sql_predict_cost", {
  description:
    "Predict the cost of a SQL query based on historical execution data. Uses a multi-tier approach: fingerprint match, template match, table scan estimate, or static heuristic.",
  parameters: z.object({
    sql: z.string().describe("SQL query to predict cost for"),
    dialect: z.string().optional().default("snowflake").describe("SQL dialect"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sql.predict_cost", {
        sql: args.sql,
        dialect: args.dialect,
      })

      return {
        title: `Cost: tier ${result.tier} [${result.confidence}]`,
        metadata: {
          tier: result.tier,
          confidence: result.confidence,
          method: result.method,
        },
        output: formatPrediction(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Cost: ERROR",
        metadata: { tier: 0, confidence: "unknown", method: "error" },
        output: `Failed to predict cost: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})

function formatPrediction(result: SqlPredictCostResult): string {
  const lines: string[] = []

  lines.push(`Prediction Method: ${result.method} (tier ${result.tier})`)
  lines.push(`Confidence: ${result.confidence}`)
  lines.push(`Observations: ${result.observation_count}`)
  lines.push("")

  if (result.predicted_bytes != null) {
    const mb = (result.predicted_bytes / (1024 * 1024)).toFixed(1)
    lines.push(`Estimated bytes scanned: ${result.predicted_bytes.toLocaleString()} (${mb} MB)`)
  }
  if (result.predicted_time_ms != null) {
    const sec = (result.predicted_time_ms / 1000).toFixed(1)
    lines.push(`Estimated execution time: ${result.predicted_time_ms.toLocaleString()} ms (${sec}s)`)
  }
  if (result.predicted_credits != null) {
    lines.push(`Estimated credits: ${result.predicted_credits}`)
  }

  if (result.observation_count === 0) {
    lines.push("")
    lines.push("Note: No historical data available. Record query feedback with sql_record_feedback to improve predictions.")
  }

  return lines.join("\n")
}
