import z from "zod"
import { Tool } from "../../tool/tool"

export const DbtSqlGraphTool = Tool.define("dbt_sql_graph", {
  description: "A dbt model's SQL as a graph: its CTEs, joins and filters, and the edges between them.",
  parameters: z.object({
    model: z.string().describe("Model name"),
  }),
  async execute() {
    return {
      title: "dbt_sql_graph: not implemented",
      metadata: { success: false, error: "not implemented" },
      output: "dbt_sql_graph is not implemented in this build of altimate-code yet.",
    }
  },
})
