import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreParseDbtTool = Tool.define("altimate_core_parse_dbt", {
  description:
    "Parse a dbt project directory using the Rust-based altimate-core engine. Extracts models, sources, tests, and project structure for analysis.",
  parameters: z.object({
    project_dir: z.string().describe("Path to the dbt project directory"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.parse_dbt", {
        project_dir: args.project_dir,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Parse dbt: ${data.models?.length ?? 0} models`,
        metadata: { success: result.success },
        output: formatParseDbt(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Parse dbt: ERROR", metadata: { success: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatParseDbt(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const lines: string[] = []
  if (data.models?.length) lines.push(`Models: ${data.models.length}`)
  if (data.sources?.length) lines.push(`Sources: ${data.sources.length}`)
  if (data.tests?.length) lines.push(`Tests: ${data.tests.length}`)
  if (data.seeds?.length) lines.push(`Seeds: ${data.seeds.length}`)
  if (!lines.length) return JSON.stringify(data, null, 2)
  return lines.join("\n")
}
