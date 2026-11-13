import z from "zod"
import { Tool } from "../../tool/tool"

export const DbtCostEstimateTool = Tool.define("dbt_cost_estimate", {
  description: "Estimate the bytes a dbt model or a SQL query would scan, from a warehouse dry run (BigQuery).",
  parameters: z.object({
    model: z.string().optional().describe("Model name to compile and estimate"),
    sql: z.string().optional().describe("SQL (may use Jinja) to compile and estimate"),
  }),
  async execute() {
    return {
      title: "dbt_cost_estimate: not implemented",
      metadata: { success: false, error: "not implemented" },
      output: "dbt_cost_estimate is not implemented in this build of altimate-code yet.",
    }
  },
})
