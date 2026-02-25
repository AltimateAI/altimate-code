import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlRecordFeedbackTool = Tool.define("sql_record_feedback", {
  description:
    "Record query execution metrics (bytes scanned, execution time, credits) for cost prediction. Builds a local feedback store that improves future cost estimates.",
  parameters: z.object({
    sql: z.string().describe("The SQL query that was executed"),
    dialect: z.string().optional().default("snowflake").describe("SQL dialect"),
    bytes_scanned: z.number().optional().describe("Bytes scanned during execution"),
    rows_produced: z.number().optional().describe("Number of rows returned"),
    execution_time_ms: z.number().optional().describe("Execution time in milliseconds"),
    credits_used: z.number().optional().describe("Warehouse credits consumed"),
    warehouse_size: z.string().optional().describe("Warehouse size (e.g. X-Small, Small, Medium)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sql.record_feedback", {
        sql: args.sql,
        dialect: args.dialect,
        bytes_scanned: args.bytes_scanned,
        rows_produced: args.rows_produced,
        execution_time_ms: args.execution_time_ms,
        credits_used: args.credits_used,
        warehouse_size: args.warehouse_size,
      })

      return {
        title: `Feedback: ${result.recorded ? "recorded" : "failed"}`,
        metadata: { recorded: result.recorded },
        output: result.recorded
          ? "Query execution metrics recorded successfully."
          : "Failed to record feedback.",
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Feedback: ERROR",
        metadata: { recorded: false },
        output: `Failed to record feedback: ${msg}\n\nEnsure the Python bridge is running and altimate-engine is installed.`,
      }
    }
  },
})
