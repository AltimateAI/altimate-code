// altimate_change - Impact analysis tool for dbt DAG-aware change assessment
//
// Combines dbt manifest parsing with column-level lineage to show downstream
// impact of model/column changes across the entire DAG.
import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

export const ImpactAnalysisTool = Tool.define("impact_analysis", {
  description: [
    "Analyze the downstream impact of a model or column change across the dbt DAG.",
    "Combines dbt manifest parsing with column-level lineage to show all affected",
    "models, tests, exposures, and sources. Use before making breaking changes to",
    "understand blast radius.",
    "",
    "Examples:",
    '- impact_analysis({ model: "stg_orders", change_type: "remove" })',
    '- impact_analysis({ model: "stg_orders", column: "order_id", change_type: "rename" })',
    '- impact_analysis({ manifest_path: "target/manifest.json", model: "dim_customers", change_type: "retype" })',
  ].join("\n"),
  parameters: z.object({
    model: z
      .string()
      .describe("dbt model name to analyze impact for (e.g., 'stg_orders', 'dim_customers')"),
    column: z
      .string()
      .optional()
      .describe("Specific column to trace impact for. If omitted, analyzes model-level impact."),
    change_type: z
      .enum(["remove", "rename", "retype", "add", "modify"])
      .describe("Type of change being considered"),
    manifest_path: z
      .string()
      .optional()
      .default("target/manifest.json")
      .describe("Path to dbt manifest.json file"),
    dialect: z
      .string()
      .optional()
      .default("snowflake")
      .describe("SQL dialect for lineage analysis"),
  }),
  // @ts-expect-error tsgo TS2719 false positive — identical pattern works in other tools
  async execute(args, ctx) {
    try {
      // Step 1: Parse the dbt manifest to get the full DAG
      const manifest = await Dispatcher.call("dbt.manifest", { path: args.manifest_path })

      if (!manifest.models || manifest.models.length === 0) {
        return {
          title: "Impact: NO MANIFEST",
          metadata: { success: false },
          output: `No models found in manifest at ${args.manifest_path}. Run \`dbt compile\` first to generate the manifest.`,
        }
      }

      // Step 2: Find the target model and its downstream dependents
      const targetModel = manifest.models.find(
        (m: { name: string }) => m.name === args.model || m.name.endsWith(`.${args.model}`),
      )

      if (!targetModel) {
        const available = manifest.models
          .slice(0, 10)
          .map((m: { name: string }) => m.name)
          .join(", ")
        return {
          title: "Impact: MODEL NOT FOUND",
          metadata: { success: false },
          output: `Model "${args.model}" not found in manifest. Available models: ${available}${manifest.models.length > 10 ? ` (+${manifest.models.length - 10} more)` : ""}`,
        }
      }

      // Step 3: Build the dependency graph and find all downstream models
      const modelsByName = new Map<string, any>()
      for (const m of manifest.models) {
        modelsByName.set(m.name, m)
      }

      // Find all models that depend on the target (direct + transitive)
      const downstream = findDownstream(args.model, manifest.models)
      const direct = downstream.filter((d) => d.depth === 1)
      const transitive = downstream.filter((d) => d.depth > 1)

      // Step 4: Report test count (manifest has test_count but not individual tests)
      const affectedTestCount = manifest.test_count ?? 0

      // Step 5: If column specified, attempt column-level lineage
      let columnImpact: string[] = []
      if (args.column) {
        try {
          const lineageResult = await Dispatcher.call("lineage.check", {
            sql: `SELECT * FROM ${args.model}`, // Use model reference for lineage tracing
            dialect: args.dialect,
          })
          if (lineageResult.data?.column_dict) {
            // Find which downstream columns reference our target column
            for (const [outCol, sources] of Object.entries(lineageResult.data.column_dict)) {
              const srcArray = Array.isArray(sources) ? sources : [sources]
              if (srcArray.some((s: any) => JSON.stringify(s).includes(args.column!))) {
                columnImpact.push(outCol)
              }
            }
          }
        } catch {
          // Column lineage is best-effort — continue without it
        }
      }

      // Step 6: Format the impact report
      const output = formatImpactReport({
        model: args.model,
        column: args.column,
        changeType: args.change_type,
        direct,
        transitive,
        affectedTestCount,
        columnImpact,
        totalModels: manifest.model_count,
      })

      const totalAffected = downstream.length
      const severity =
        totalAffected === 0
          ? "SAFE"
          : totalAffected <= 3
            ? "LOW"
            : totalAffected <= 10
              ? "MEDIUM"
              : "HIGH"

      return {
        title: `Impact: ${severity} — ${totalAffected} downstream model${totalAffected !== 1 ? "s" : ""} affected`,
        metadata: {
          success: true,
          severity,
          direct_count: direct.length,
          transitive_count: transitive.length,
          test_count: affectedTestCount,
          column_impact: columnImpact.length,
        },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Impact: ERROR",
        metadata: { success: false },
        output: `Failed to analyze impact: ${msg}\n\nEnsure the dbt manifest exists (run \`dbt compile\`) and the dispatcher is running.`,
      }
    }
  },
})

interface DownstreamModel {
  name: string
  depth: number
  materialized?: string
  path: string[]
}

function findDownstream(
  targetName: string,
  models: Array<{ name: string; depends_on: string[]; materialized?: string }>,
): DownstreamModel[] {
  const results: DownstreamModel[] = []
  const visited = new Set<string>()

  function walk(name: string, depth: number, path: string[]) {
    for (const model of models) {
      if (visited.has(model.name)) continue
      const deps = model.depends_on.map((d) => d.split(".").pop())
      if (deps.includes(name)) {
        visited.add(model.name)
        const newPath = [...path, model.name]
        results.push({
          name: model.name,
          depth,
          materialized: model.materialized,
          path: newPath,
        })
        walk(model.name, depth + 1, newPath)
      }
    }
  }

  walk(targetName, 1, [targetName])
  return results
}

function formatImpactReport(data: {
  model: string
  column?: string
  changeType: string
  direct: DownstreamModel[]
  transitive: DownstreamModel[]
  affectedTestCount: number
  columnImpact: string[]
  totalModels: number
}): string {
  const lines: string[] = []

  // Header
  const target = data.column ? `${data.model}.${data.column}` : data.model
  lines.push(`Impact Analysis: ${data.changeType.toUpperCase()} ${target}`)
  lines.push("".padEnd(60, "="))

  const totalAffected = data.direct.length + data.transitive.length
  const pct = data.totalModels > 0 ? ((totalAffected / data.totalModels) * 100).toFixed(1) : "0"
  lines.push(`Blast radius: ${totalAffected}/${data.totalModels} models (${pct}%)`)
  lines.push("")

  // Risk assessment
  if (data.changeType === "remove" && totalAffected > 0) {
    lines.push("WARNING: This is a BREAKING change. All downstream models will fail.")
    lines.push("")
  } else if (data.changeType === "rename" && totalAffected > 0) {
    lines.push("WARNING: Rename requires updating all downstream references.")
    lines.push("")
  } else if (data.changeType === "retype" && totalAffected > 0) {
    lines.push("CAUTION: Type change may cause implicit casts or failures in downstream models.")
    lines.push("")
  }

  // Direct dependents
  if (data.direct.length > 0) {
    lines.push(`Direct Dependents (${data.direct.length})`)
    lines.push("".padEnd(40, "-"))
    for (const d of data.direct) {
      const mat = d.materialized ? ` [${d.materialized}]` : ""
      lines.push(`  ${d.name}${mat}`)
    }
    lines.push("")
  }

  // Transitive dependents
  if (data.transitive.length > 0) {
    lines.push(`Transitive Dependents (${data.transitive.length})`)
    lines.push("".padEnd(40, "-"))
    for (const d of data.transitive) {
      const mat = d.materialized ? ` [${d.materialized}]` : ""
      const path = d.path.join(" → ")
      lines.push(`  ${d.name}${mat} (via: ${path})`)
    }
    lines.push("")
  }

  // Column impact
  if (data.column && data.columnImpact.length > 0) {
    lines.push(`Affected Output Columns (${data.columnImpact.length})`)
    lines.push("".padEnd(40, "-"))
    for (const col of data.columnImpact) {
      lines.push(`  ${col}`)
    }
    lines.push("")
  }

  // Affected tests
  if (data.affectedTestCount > 0) {
    lines.push(`Tests in project: ${data.affectedTestCount}`)
    lines.push("".padEnd(40, "-"))
    lines.push(`  Run \`dbt test\` to verify all ${data.affectedTestCount} tests still pass after this change.`)
    lines.push("")
  }

  // No impact
  if (totalAffected === 0) {
    lines.push("No downstream models depend on this. Change is safe to make.")
  }

  // Recommendations
  if (totalAffected > 0) {
    lines.push("Recommended Actions")
    lines.push("".padEnd(40, "-"))
    if (data.changeType === "remove") {
      lines.push("1. Update all downstream models to remove references")
      lines.push("2. Run `dbt test` to verify no broken references")
      lines.push("3. Consider deprecation period before removal")
    } else if (data.changeType === "rename") {
      lines.push("1. Update all downstream SQL references to new name")
      lines.push("2. Run `dbt compile` to verify all models compile")
      lines.push("3. Run `dbt test` to verify correctness")
    } else if (data.changeType === "retype") {
      lines.push("1. Check downstream models for implicit type casts")
      lines.push("2. Verify aggregations and joins still work correctly")
      lines.push("3. Run `dbt test` with data validation")
    } else {
      lines.push("1. Review downstream models for compatibility")
      lines.push("2. Run `dbt compile` and `dbt test`")
    }
  }

  return lines.join("\n")
}
