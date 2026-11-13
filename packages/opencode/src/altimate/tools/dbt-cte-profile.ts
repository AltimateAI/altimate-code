import z from "zod"
import { Tool } from "../../tool/tool"

export const DbtCteProfileTool = Tool.define("dbt_cte_profile", {
  description: "List a dbt model's CTEs, or time one CTE with a row-count query.",
  parameters: z.object({
    model: z.string().describe("Model name"),
    cte: z.string().optional().describe("CTE to time; without it, the CTE list is returned"),
  }),
  async execute() {
    return {
      title: "dbt_cte_profile: not implemented",
      metadata: { success: false, error: "not implemented" },
      output: "dbt_cte_profile is not implemented in this build of altimate-code yet.",
    }
  },
})
