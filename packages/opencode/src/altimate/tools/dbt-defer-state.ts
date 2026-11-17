import z from "zod"
import { Tool } from "../../tool/tool"

export const DbtDeferStateTool = Tool.define("dbt_defer_state", {
  description: "dbt Power User's defer-to-production setting for a dbt project, and the profile's default target.",
  parameters: z.object({
    project_dir: z.string().describe("dbt project folder"),
  }),
  async execute() {
    return {
      title: "dbt_defer_state: not implemented",
      metadata: { success: false, error: "not implemented" },
      output: "dbt_defer_state is not implemented in this build of altimate-code yet.",
    }
  },
})
