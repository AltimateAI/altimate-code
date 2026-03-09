import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"
import type { DbtLineageResult } from "../bridge/protocol"

export const DbtLineageTool = Tool.define("dbt_lineage", {
  description:
    "Compute column-level lineage for a dbt model using the Rust-based altimate-core engine. Takes a manifest.json path and model name, extracts compiled SQL and upstream schemas, and traces column flow.",
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

      const hasError = result.confidence_factors.length > 0 && result.confidence === "low"

      return {
        title: `dbt Lineage: ${result.model_name} [${result.confidence}]`,
        metadata: {
          model_name: result.model_name,
          confidence: result.confidence,
        },
        output: formatDbtLineage(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "dbt Lineage: ERROR",
        metadata: { model_name: args.model, confidence: "unknown" },
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

  const lineage = result.raw_lineage
  if (!lineage || Object.keys(lineage).length === 0) {
    lines.push("No lineage data returned.")
    if (!result.compiled_sql) {
      lines.push("Run `dbt compile` first to generate compiled SQL.")
    }
    return lines.join("\n")
  }

  // column_dict: output columns -> source columns mapping
  const columnDict = lineage.column_dict as Record<string, unknown> | undefined
  if (columnDict) {
    lines.push("Column Mappings:")
    for (const [target, sources] of Object.entries(columnDict)) {
      lines.push(`  ${target} ← ${JSON.stringify(sources)}`)
    }
    lines.push("")
  }

  // column_lineage: detailed edge list
  const edges = lineage.column_lineage as unknown[] | undefined
  if (edges?.length) {
    lines.push("Lineage Edges:")
    for (const edge of edges) {
      lines.push(`  ${JSON.stringify(edge)}`)
    }
  }

  if (!columnDict && !edges) {
    lines.push(JSON.stringify(lineage, null, 2))
  }

  return lines.join("\n")
}
