import z from "zod"
import { Tool } from "../../tool/tool"

export const DbtDocsCoverageTool = Tool.define("dbt_docs_coverage", {
  description: "Documentation coverage of a dbt model: which output columns have a description, and whether the model has one.",
  parameters: z.object({
    model: z.string().describe("Model name"),
    manifest_path: z.string().optional().describe("manifest.json to read (default: the dbt project's target/manifest.json)"),
  }),
  async execute() {
    return {
      title: "dbt_docs_coverage: not implemented",
      metadata: { success: false },
      output: "dbt_docs_coverage is not implemented in this build of altimate-code yet.",
    }
  },
})
