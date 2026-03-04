import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"

export const AltimateCoreResolveTermTool = Tool.define("altimate_core_resolve_term", {
  description:
    "Resolve a business glossary term to schema elements using fuzzy matching via the Rust-based altimate-core engine. Maps human-readable terms like 'revenue' or 'customer' to actual table/column names.",
  parameters: z.object({
    term: z.string().describe("Business term to resolve (e.g. 'revenue', 'customer email')"),
    schema_path: z.string().optional().describe("Path to YAML/JSON schema file"),
    schema_context: z.record(z.string(), z.any()).optional().describe("Inline schema definition"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("altimate_core.resolve_term", {
        term: args.term,
        schema_path: args.schema_path ?? "",
        schema_context: args.schema_context,
      })
      const data = result.data as Record<string, any>
      const matchCount = data.matches?.length ?? 0
      return {
        title: `Resolve: ${matchCount} match(es) for "${args.term}"`,
        metadata: { success: result.success, match_count: matchCount },
        output: formatResolveTerm(data, args.term),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { title: "Resolve: ERROR", metadata: { success: false, match_count: 0 }, output: `Failed: ${msg}` }
    }
  },
})

function formatResolveTerm(data: Record<string, any>, term: string): string {
  if (data.error) return `Error: ${data.error}`
  if (!data.matches?.length) return `No schema elements match "${term}".`
  const lines = [`Matches for "${term}":\n`]
  for (const m of data.matches) {
    lines.push(`  ${m.fqn ?? `${m.table}.${m.column}`} (${m.score ?? m.confidence} match)`)
  }
  return lines.join("\n")
}
