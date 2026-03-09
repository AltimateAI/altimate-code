import z from "zod"
import { Tool } from "../../tool/tool"
import { Bridge } from "../bridge/client"
import type { DbtManifestResult } from "../bridge/protocol"

export const DbtManifestTool = Tool.define("dbt_manifest", {
  description:
    "Parse a dbt manifest.json file to extract models, sources, tests, and dependencies. Useful for understanding project structure and lineage.",
  parameters: z.object({
    path: z.string().describe("Path to the dbt manifest.json file (e.g. target/manifest.json)"),
  }),
  async execute(args, ctx) {
    try {
      const result = await Bridge.call("dbt.manifest", { path: args.path })

      return {
        title: `Manifest: ${result.model_count} models, ${result.source_count} sources`,
        metadata: {
          model_count: result.model_count,
          source_count: result.source_count,
          test_count: result.test_count,
          snapshot_count: result.snapshot_count,
          seed_count: result.seed_count,
        },
        output: formatManifest(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Manifest: ERROR",
        metadata: { model_count: 0, source_count: 0, test_count: 0, snapshot_count: 0, seed_count: 0 },
        output: `Failed to parse manifest: ${msg}\n\nEnsure the manifest.json exists and the Python bridge is running.`,
      }
    }
  },
})

function formatManifest(result: DbtManifestResult): string {
  const lines: string[] = []

  lines.push("=== Project Summary ===")
  lines.push(`Models: ${result.model_count}`)
  lines.push(`Sources: ${result.source_count}`)
  lines.push(`Tests: ${result.test_count}`)
  lines.push(`Snapshots: ${result.snapshot_count}`)
  lines.push(`Seeds: ${result.seed_count}`)

  if (result.models.length > 0) {
    lines.push("")
    lines.push("=== Models ===")
    lines.push("Name | Schema | Materialized | Dependencies | Columns")
    lines.push("-----|--------|-------------|-------------|--------")
    for (const model of result.models) {
      const deps = model.depends_on.length > 0 ? model.depends_on.map((d) => d.split(".").pop()).join(", ") : "-"
      const cols = model.columns.length > 0 ? model.columns.map((c) => c.name).join(", ") : "-"
      lines.push(`${model.name} | ${model.schema_name ?? "-"} | ${model.materialized ?? "-"} | ${deps} | ${cols}`)
    }
  }

  if (result.sources.length > 0) {
    lines.push("")
    lines.push("=== Sources ===")
    lines.push("Source | Table | Schema | Columns")
    lines.push("-------|-------|--------|--------")
    for (const source of result.sources) {
      const cols = source.columns.length > 0 ? source.columns.map((c) => c.name).join(", ") : "-"
      lines.push(`${source.source_name} | ${source.name} | ${source.schema_name ?? "-"} | ${cols}`)
    }
  }

  return lines.join("\n")
}
