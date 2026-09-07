import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const AltimateCoreTrackLineageTool = Tool.define("altimate_core_track_lineage", {
  description:
    "Track lineage across multiple SQL queries. Builds a combined lineage graph from a sequence of queries. Runs fully offline via the native engine — no API key or account required. Provide schema_context or schema_path for accurate table/column resolution.",
  parameters: z.object({
    queries: z.array(z.string()).describe("List of SQL queries to track lineage across"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Dispatcher.call("altimate_core.track_lineage", {
        queries: args.queries,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = (result.data ?? {}) as Record<string, any>
      const edgeCount = collectEdges(data).length
      const error = result.error ?? data.error
      return {
        // Never render "0 edges" when the engine call itself failed.
        title: error ? "Track Lineage: ERROR" : `Track Lineage: ${edgeCount} edge(s) across ${args.queries.length} queries`,
        metadata: { success: result.success, edge_count: edgeCount, ...(error && { error }) },
        output: error ? `Error: ${error}` : formatTrackLineage(data),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Track Lineage: ERROR",
        metadata: { success: false, edge_count: 0, error: msg },
        output: `Failed: ${msg}`,
      }
    }
  },
})

/** Engine shape (LineageResult): edges live under queries[].edges, not at the top level. */
function collectEdges(data: Record<string, any>): any[] {
  if (Array.isArray(data.queries)) return data.queries.flatMap((q: any) => q.edges ?? [])
  return data.edges ?? []
}

/** Column refs are { table, column } objects; legacy shape was a plain string. */
function refToString(ref: any): string {
  if (ref == null) return "?"
  if (typeof ref === "string") return ref
  return [ref.table, ref.column].filter(Boolean).join(".") || "?"
}

function formatTrackLineage(data: Record<string, any>): string {
  if (data.error) return `Error: ${data.error}`
  const edges = collectEdges(data)
  if (!edges.length) return "No lineage edges found across queries."
  const lines = ["Lineage graph:\n"]
  for (const edge of edges) {
    const transform = edge.transform_type ?? edge.transform
    lines.push(`  ${refToString(edge.source)} -> ${refToString(edge.target)}${transform ? ` (${transform})` : ""}`)
  }
  if (Array.isArray(data.impact_map) && data.impact_map.length) {
    lines.push("\nImpact map:")
    for (const entry of data.impact_map) {
      const affected = (entry.affected ?? []).map(refToString).join(", ")
      lines.push(`  ${refToString(entry.source)} affects: ${affected || "(none)"}`)
    }
  }
  return lines.join("\n")
}
