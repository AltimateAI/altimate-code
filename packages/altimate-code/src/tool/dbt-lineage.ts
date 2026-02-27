import z from "zod"
import { Tool } from "./tool"
import { Bridge } from "../bridge/client"
import type { DbtLineageResult } from "../bridge/protocol"

export const DbtLineageTool = Tool.define("dbt_lineage", {
  description:
    "Compute column-level lineage for a dbt model. Takes a manifest.json path and model name, extracts compiled SQL and upstream schemas, and traces how source columns flow to output columns.",
  parameters: z.object({
    manifest_path: z.string().describe("Path to dbt manifest.json file"),
    model: z.string().describe("Model name or unique_id (e.g. 'my_model' or 'model.project.my_model')"),
    dialect: z.string().optional().describe("SQL dialect override (auto-detected from manifest if omitted)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("dbt.lineage", {
        manifest_path: args.manifest_path,
        model: args.model,
        dialect: args.dialect,
      })

      return {
        title: `dbt Lineage: ${result.model_name} — ${result.edges.length} edge(s) [${result.confidence}]`,
        metadata: {
          model_name: result.model_name,
          edgeCount: result.edges.length,
          tableCount: result.tables.length,
          confidence: result.confidence,
        },
        output: formatDbtLineage(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "dbt Lineage: ERROR",
        metadata: { model_name: args.model, edgeCount: 0, tableCount: 0, confidence: "unknown" },
        output: `Failed: ${msg}`,
      }
    }
  },
})

function formatDbtLineage(result: DbtLineageResult): string {
  const lines: string[] = []

  lines.push(`Model: ${result.model_name}`)
  if (result.model_unique_id) lines.push(`ID: ${result.model_unique_id}`)
  lines.push("")

  if (result.confidence_factors.length > 0) {
    lines.push(`Confidence: ${result.confidence}`)
    lines.push(`  Note: ${result.confidence_factors.join("; ")}`)
    lines.push("")
  }

  if (result.edges.length === 0) {
    lines.push("No column-level lineage edges detected.")
    if (!result.compiled_sql) {
      lines.push("Run `dbt compile` first to generate compiled SQL.")
    }
    return lines.join("\n")
  }

  lines.push("Column Lineage:")
  lines.push("Source → Target | Transform")
  lines.push("".padEnd(60, "-"))

  for (const edge of result.edges) {
    const transform = edge.transform ? ` | ${edge.transform}` : ""
    lines.push(`${edge.source_table}.${edge.source_column} → ${edge.target_table}.${edge.target_column}${transform}`)
  }

  lines.push("")
  lines.push(`Tables: ${result.tables.join(", ")}`)

  return lines.join("\n")
}
