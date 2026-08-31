import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import { guardExternalFile, isPermissionError } from "./schema-path-guard"

export const AltimateCoreParseDbtTool = Tool.define("altimate_core_parse_dbt", {
  description: "Parse a dbt project directory. Extracts models, sources, tests, and project structure for analysis.",
  parameters: z.object({
    project_dir: z.string().describe("Path to the dbt project directory"),
  }),
  async execute(args, ctx) {
    try {
      // A project dir outside the workspace goes through the external_directory
      // gate, like every other path-taking read. guardExternalFile resolves
      // relative paths against the project directory and degrades gracefully
      // outside an Instance context (direct/test invocation).
      // Empty input means "the current project" — normalize before the guard
      // so the parser never receives an empty path.
      const resolved = (await guardExternalFile(ctx, args.project_dir || ".", "directory")) ?? "."
      const result = await Dispatcher.call("altimate_core.parse_dbt", {
        project_dir: resolved,
      })
      const data = (result.data ?? {}) as Record<string, any>
      const error = result.error ?? data.error
      return {
        title: `Parse dbt: ${data.models?.length ?? 0} models`,
        metadata: { success: result.success, ...(error && { error }) },
        output: formatParseDbt(data),
      }
    } catch (e) {
      if (isPermissionError(e)) throw e
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Parse dbt: ERROR", metadata: { success: false, error: msg }, output: `Failed: ${msg}` }
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
