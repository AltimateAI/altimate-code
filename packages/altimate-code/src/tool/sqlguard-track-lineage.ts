import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const SqlGuardTrackLineageTool = Tool.define("sqlguard_track_lineage", {
  description:
    "Track lineage across multiple SQL queries using the Rust-based sqlguard engine. Builds a combined lineage graph from a sequence of queries. Requires sqlguard.init() with API key.",
  parameters: z.object({
    queries: z.array(z.string()).describe("List of SQL queries to track lineage across"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("sqlguard.track_lineage", {
        queries: args.queries,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const edgeCount = data.edges?.length ?? 0
      return {
        title: `Track Lineage: ${edgeCount} edge(s) across ${args.queries.length} queries`,
        metadata: { success: result.success, edge_count: edgeCount },
        output: formatTrackLineage(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Track Lineage: ERROR", metadata: { success: false, edge_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatTrackLineage(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  if (!data.edges?.length) return "No lineage edges found across queries."
  const lines = ["Lineage graph:\n"]
  for (const edge of data.edges) {
    lines.push(`  ${edge.source} -> ${edge.target}${edge.transform ? ` (${edge.transform})` : ""}`)
  }
  return lines.join("\n")
}
