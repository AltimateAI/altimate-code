import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardExportDdlTool = Tool.define("sqlguard_export_ddl", {
  description:
    "Export a YAML/JSON schema as CREATE TABLE DDL statements using the Rust-based sqlguard engine.",
  parameters: z.object({
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.export_ddl", {
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      return {
        title: "Export DDL: done",
        metadata: { success: result.success },
        output: data.ddl ?? JSON.stringify(data, null, 2),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Export DDL: ERROR", metadata: { success: false }, output: `Failed: ${msg}` }
    }
  },
})
