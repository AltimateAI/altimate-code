import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreIntrospectionSqlTool = Tool.define("altimate_core_introspection_sql", {
  description:
    "Generate INFORMATION_SCHEMA introspection queries for a given database type using the Rust-based altimate-core engine. Supports postgres, bigquery, snowflake, mysql, mssql, redshift.",
  parameters: z.object({
    db_type: z.string().describe("Database type (postgres, bigquery, snowflake, mysql, mssql, redshift)"),
    database: z.string().describe("Database name to introspect"),
    schema_name: z.string().optional().describe("Optional schema name to narrow introspection"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.introspection_sql", {
        db_type: args.db_type,
        database: args.database,
        schema_name: args.schema_name,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Introspection SQL: ${args.db_type}`,
        metadata: { success: result.success, db_type: args.db_type },
        output: formatIntrospectionSql(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Introspection SQL: ERROR", metadata: { success: false, db_type: args.db_type }, output: `Failed: ${msg}` }
    }
  },
})

function formatIntrospectionSql(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (data.queries) {
    const lines: string[] = []
    for (const [name, sql] of Object.entries(data.queries)) {
      lines.push(`--- ${name} ---`)
      lines.push(String(sql))
      lines.push("")
    }
    return lines.join("\n")
  }
  return JSON.stringify(data, null, 2)
}
