import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardImportDdlTool = Tool.define("sqlguard_import_ddl", {
  description:
    "Convert CREATE TABLE DDL into YAML schema definition using the Rust-based sqlguard engine. Parses DDL statements and produces a structured schema that other sqlguard tools can consume.",
  parameters: z.object({
    ddl: z.string().describe("CREATE TABLE DDL statements to parse"),
    dialect: z.string().optional().describe("SQL dialect of the DDL"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.import_ddl", {
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
