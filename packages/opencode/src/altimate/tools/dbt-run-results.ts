import z from "zod"
import { Tool } from "../../tool/tool"

export const DbtRunResultsTool = Tool.define("dbt_run_results", {
  description: "The latest dbt run's results from target/run_results.json: command, duration and each node's status.",
  parameters: z.object({
    project_dir: z.string().optional().describe("dbt project folder (default: the dbt project found from the working directory)"),
  }),
  async execute() {
    return {
      title: "dbt_run_results: not implemented",
      metadata: { success: false },
      output: "dbt_run_results is not implemented in this build of altimate-code yet.",
    }
  },
})
