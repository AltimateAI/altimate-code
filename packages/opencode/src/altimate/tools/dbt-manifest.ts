import z from "zod"
import path from "path"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import { assertExternalDirectoryLegacy } from "../../tool/external-directory"
import type { DbtManifestResult } from "../native/types"

export const DbtManifestTool = Tool.define("dbt_manifest", {
  description:
    "Parse a dbt manifest.json file to extract models, sources, tests, and dependencies. Useful for understanding project structure and lineage.",
  parameters: z.object({
    path: z.string().describe("Path to the dbt manifest.json file (e.g. target/manifest.json)"),
  }),
  async execute(args, ctx) {
    try {
      // A manifest path outside the project must go through the same
      // external_directory permission gate as file reads — otherwise this tool
      // silently reads sibling/private projects' model inventories.
      await assertExternalDirectoryLegacy(ctx as any, path.resolve(args.path), { kind: "file" })
      const result = await Dispatcher.call("dbt.manifest", { path: args.path })

      return {
        title: `Manifest: ${result.model_count ?? 0} models, ${result.source_count ?? 0} sources`,
        metadata: {
          model_count: result.model_count,
          source_count: result.source_count,
          test_count: result.test_count,
          snapshot_count: result.snapshot_count,
          seed_count: result.seed_count,
          ...((result as any).error && { error: (result as any).error }),
        },
        output: formatManifest(result),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Manifest: ERROR",
        metadata: { model_count: 0, source_count: 0, test_count: 0, snapshot_count: 0, seed_count: 0, error: msg },
        output: `Failed to parse manifest: ${msg}\n\nEnsure the manifest.json exists and the dispatcher is running.`,
      }
    }
  },
})

function formatManifest(result: DbtManifestResult): string {
  const lines: string[] = []

  lines.push("=== Project Summary ===")
  lines.push(`Models: ${result.model_count ?? 0}`)
  lines.push(`Sources: ${result.source_count ?? 0}`)
  lines.push(`Tests: ${result.test_count ?? 0}`)
  lines.push(`Snapshots: ${result.snapshot_count ?? 0}`)
  lines.push(`Seeds: ${result.seed_count ?? 0}`)

  const models = result.models ?? []
  const sources = result.sources ?? []

  if (models.length > 0) {
    lines.push("")
    lines.push("=== Models ===")
    lines.push("Name | Schema | Materialized | Dependencies | Columns")
    lines.push("-----|--------|-------------|-------------|--------")
    for (const model of models) {
      const depsArr = model.depends_on ?? []
      const colsArr = model.columns ?? []
      const deps = depsArr.length > 0 ? depsArr.map((d) => d.split(".").pop()).join(", ") : "-"
      const cols = colsArr.length > 0 ? colsArr.map((c) => c.name).join(", ") : "-"
      lines.push(`${model.name ?? "-"} | ${model.schema_name ?? "-"} | ${model.materialized ?? "-"} | ${deps} | ${cols}`)
    }
  }

  if (sources.length > 0) {
    lines.push("")
    lines.push("=== Sources ===")
    lines.push("Source | Table | Schema | Columns")
    lines.push("-------|-------|--------|--------")
    for (const source of sources) {
      const sourceCols = source.columns ?? []
      const cols = sourceCols.length > 0 ? sourceCols.map((c) => c.name).join(", ") : "-"
      lines.push(`${source.source_name ?? "-"} | ${source.name ?? "-"} | ${source.schema_name ?? "-"} | ${cols}`)
    }
  }

  return lines.join("\n")
}
