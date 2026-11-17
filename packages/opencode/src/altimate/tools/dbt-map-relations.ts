import z from "zod"
import { Tool } from "../../tool/tool"

export const DbtMapRelationsTool = Tool.define("dbt_map_relations", {
  description: "Map each table a raw SQL query reads to the dbt ref() or source() for it, from the manifest.",
  parameters: z.object({
    sql: z.string().describe("Raw SQL to map"),
    dialect: z.string().optional().describe("SQL dialect of the query"),
    manifest_path: z
      .string()
      .optional()
      .describe("manifest.json to match against (default: the dbt project's target/manifest.json)"),
  }),
  async execute() {
    return {
      title: "dbt_map_relations: not implemented",
      metadata: { success: false, error: "not implemented" },
      output: "dbt_map_relations is not implemented in this build of altimate-code yet.",
    }
  },
})
