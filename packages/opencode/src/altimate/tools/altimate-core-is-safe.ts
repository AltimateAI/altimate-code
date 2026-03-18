import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreIsSafeTool = Tool.define("altimate_core_is_safe", {
  description:
    "Quick boolean safety check for SQL using the Rust-based altimate-core engine. Returns true/false indicating whether the SQL is safe to execute (no injection, no destructive operations).",
  parameters: z.object({
    sql: z.string().describe("SQL query to check"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.is_safe", {
        sql: args.sql,
      })
      const data = result.data as Record<string, any>
      return {
        title: `Is Safe: ${data.safe ? "YES" : "NO"}`,
        metadata: { success: result.success, safe: data.safe },
        output: data.safe ? "SQL is safe to execute." : "SQL is NOT safe — may contain injection or destructive operations.",
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Is Safe: ERROR", metadata: { success: false, safe: false }, output: `Failed: ${msg}` }
    }
  },
})
