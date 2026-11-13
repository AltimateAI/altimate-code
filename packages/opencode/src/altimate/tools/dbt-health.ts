import z from "zod"
import { Tool } from "../../tool/tool"

export const DbtHealthTool = Tool.define("dbt_health", {
  description: "DataPilot project health insights for the dbt project.",
  parameters: z.object({
    config_path: z.string().optional().describe("DataPilot config file to use"),
  }),
  async execute() {
    return {
      title: "dbt_health: not implemented",
      metadata: { success: false },
      output: "dbt_health is not implemented in this build of altimate-code yet.",
    }
  },
})
