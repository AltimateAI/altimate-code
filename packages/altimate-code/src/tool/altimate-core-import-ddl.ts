import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreImportDdlTool = Tool.define("altimate_core_import_ddl", {
  description:
    "Convert CREATE TABLE DDL into YAML schema definition using the Rust-based altimate-core engine. Parses DDL statements and produces a structured schema that other altimate-core tools can consume.",
  parameters: z.object({
    ddl: z.string().describe("CREATE TABLE DDL statements to parse"),
    dialect: z.string().optional().describe("SQL dialect of the DDL"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.import_ddl", {
        ddl: args.ddl,
        dialect: args.dialect ?? "",
      })
      const data = result.data as Record<string, any>
      return {
        title: "Import DDL: done",
        metadata: { success: result.success },
        output: formatImportDdl(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Import DDL: ERROR", metadata: { success: false }, output: `Failed: ${msg}` }
    }
  },
})

function formatImportDdl(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.schema) return JSON.stringify(data.schema, null, 2)
  return JSON.stringify(data, null, 2)
}
