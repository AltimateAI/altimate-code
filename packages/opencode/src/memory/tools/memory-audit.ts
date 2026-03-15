import z from "zod"
import { Tool } from "../../tool/tool"
import { MemoryStore } from "../store"

export const MemoryAuditTool = Tool.define("altimate_memory_audit", {
  description:
    "View the Altimate Memory audit log — a record of all memory create, update, and delete operations. Useful for debugging when a memory was written or deleted, and by which session.",
  parameters: z.object({
    scope: z
      .enum(["global", "project", "all"])
      .optional()
      .default("all")
      .describe("Which scope to show audit log for"),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .default(50)
      .describe("Maximum number of log entries to return (most recent first)"),
  }),
  async execute(args, ctx) {
    try {
      const scopes: Array<"global" | "project"> =
        args.scope === "all" ? ["global", "project"] : [args.scope as "global" | "project"]

      const allEntries: string[] = []
      for (const scope of scopes) {
        const entries = await MemoryStore.readAuditLog(scope, args.limit)
        allEntries.push(...entries)
      }

      if (allEntries.length === 0) {
        return {
          title: "Memory Audit: empty",
          metadata: { count: 0 },
          output: "No audit log entries found. The audit log records memory create, update, and delete operations.",
        }
      }

      // Sort by timestamp (entries start with [ISO-date])
      allEntries.sort()
      const trimmed = allEntries.slice(-args.limit!)

      return {
        title: `Memory Audit: ${trimmed.length} entries`,
        metadata: { count: trimmed.length },
        output: trimmed.join("\n"),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Memory Audit: ERROR",
        metadata: { count: 0 },
        output: `Failed to read audit log: ${msg}`,
      }
    }
  },
})
