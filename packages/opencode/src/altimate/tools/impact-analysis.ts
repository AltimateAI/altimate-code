// altimate_change - Impact analysis tool for dbt DAG-aware change assessment
//
// Combines dbt manifest parsing with column-level lineage to show downstream
// impact of model/column changes across the entire DAG.
import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import type { Telemetry } from "../telemetry"
import { columnReach, exposuresOn, type ColumnReach, type ColumnReachExposure } from "../native/dbt/column-reach"

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
    model: z.string().describe("dbt model name or unique_id to analyze impact for (e.g., 'stg_orders', 'model.shop.dim_customers')"),
    column: z
      .string()
      .optional()
      .describe("Specific column to trace impact for. If omitted, analyzes model-level impact."),
    change_type: z.enum(["remove", "rename", "retype", "add", "modify"]).describe("Type of change being considered"),
    manifest_path: z.string().optional().default("target/manifest.json").describe("Path to dbt manifest.json file"),
    dialect: z.string().optional().describe("SQL dialect for column lineage (auto-detected from the manifest if omitted)"),
  }),
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
      const targetModel =
        manifest.models.find((m: { unique_id?: string }) => m.unique_id === args.model) ??
        manifest.models.find((m: { name: string }) => m.name === args.model || m.name.endsWith(`.${args.model}`))

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
      // Find all models that depend on the target (direct + transitive)
      const downstream = findDownstream(targetModel.name, manifest.models, targetModel.unique_id)
      const direct = downstream.filter((d) => d.depth === 1)
      const transitive = downstream.filter((d) => d.depth > 1)

      // Step 4: Count only tests that reference the target model or its downstream models
      const affectedModelIds = new Set(
        [targetModel.unique_id, ...downstream.map((d) => d.unique_id)].filter(
          (id): id is string => Boolean(id),
        ),
      )
      const affectedTests = (manifest.tests ?? []).filter((t) =>
        t.depends_on?.some((dep) => affectedModelIds.has(dep)),
      )
      const affectedTestCount = affectedTests.length

      // Step 5: Exposures (dashboards) on the model or anything downstream, and, for a column, the
      // downstream models whose SQL reads it, traced model by model through the compiled manifest.
      let exposures: ColumnReachExposure[] = []
      let reach: ColumnReach | undefined
      let reachError: string | undefined
      let exposuresError: string | undefined
      try {
        exposures = exposuresOn(args.manifest_path, affectedModelIds)
      } catch (error) {
        // A manifest the parser read but the raw loader cannot: say so rather than imply no dashboards.
        exposuresError = error instanceof Error ? error.message : String(error)
      }
      if (args.column) {
        try {
          reach = columnReach(args.manifest_path, targetModel.unique_id ?? args.model, args.column, args.dialect)
        } catch (error) {
          // The model-level impact still stands; the reason is reported beside it.
          reachError = error instanceof Error ? error.message : String(error)
        }
      }

      // Step 6: Format the impact report
      const output = formatImpactReport({
        model: targetModel.name,
        column: args.column,
        changeType: args.change_type,
        direct,
        transitive,
        affectedTestCount,
        totalModels: manifest.model_count,
        exposures,
        exposuresError,
        columnReach: reach,
        columnReachError: reachError,
      })

      const totalAffected = downstream.length
      const severity =
        totalAffected === 0 ? "SAFE" : totalAffected <= 3 ? "LOW" : totalAffected <= 10 ? "MEDIUM" : "HIGH"

      // altimate_change start — sql quality findings for telemetry
      const findings: Telemetry.Finding[] = []
      if (totalAffected > 0) {
        findings.push({ category: `impact_${severity.toLowerCase()}` })
        for (const d of direct) {
          findings.push({ category: "impact_direct_dependent" })
        }
        for (const t of transitive) {
          findings.push({ category: "impact_transitive_dependent" })
        }
      }
      // altimate_change end
      return {
        title: `Impact: ${severity} — ${totalAffected} downstream model${totalAffected !== 1 ? "s" : ""} affected`,
        metadata: {
          success: true,
          severity,
          direct_count: direct.length,
          transitive_count: transitive.length,
          test_count: affectedTestCount,
          column_reader_count: reach ? reach.models.length : 0,
          has_schema: false,
          model: targetModel.name,
          column: args.column ?? null,
          change_type: args.change_type,
          downstream: downstream.map((d) => ({ name: d.name, ...(d.unique_id && { unique_id: d.unique_id }), depth: d.depth, materialized: d.materialized ?? null })),
          exposures,
          ...(reach && { column_reach: reach }),
          ...(reachError && { column_reach_error: reachError }),
          ...(exposuresError && { exposures_error: exposuresError }),
          ...(findings.length > 0 && { findings }),
        },
        output,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Impact: ERROR",
        metadata: { success: false, has_schema: false, error: msg },
        output: `Failed to analyze impact: ${msg}\n\nEnsure the dbt manifest exists (run \`dbt compile\`) and the dispatcher is running.`,
      }
    }
  },
})

export interface DownstreamModel {
  name: string
  /** The node's unique_id when the manifest gives one (versions of a model share a name). */
  unique_id?: string
  depth: number
  materialized?: string
  path: string[]
}

export function findDownstream(
  targetName: string,
  models: Array<{ name: string; unique_id?: string; depends_on: string[]; materialized?: string }>,
  targetId?: string,
): DownstreamModel[] {
  const results: DownstreamModel[] = []
  const visited = new Set<string>()

  // Breadth-first so a model's depth is its shortest distance from the target. A parent is matched
  // by unique_id when known (a versioned model's id ends in its version, not its name; another
  // package may have a model of the same name), else by the last segment of each dependency id.
  let level: { name: string; id: string | undefined; path: string[] }[] = [
    { name: targetName, id: targetId, path: [targetName] },
  ]
  for (let depth = 1; level.length > 0; depth++) {
    const next: typeof level = []
    for (const parent of level) {
      for (const model of models) {
        const key = model.unique_id ?? model.name
        if (visited.has(key)) continue
        // An exact id decides alone: another package's model of the same name is not this one.
        const reads = parent.id ? model.depends_on.includes(parent.id) : model.depends_on.some((d) => d.split(".").pop() === parent.name)
        if (!reads) continue
        visited.add(key)
        const path = [...parent.path, model.name]
        results.push({
          name: model.name,
          ...(model.unique_id && { unique_id: model.unique_id }),
          depth,
          materialized: model.materialized,
          path,
        })
        next.push({ name: model.name, id: model.unique_id, path })
      }
    }
    level = next
  }
  return results
}

export function formatImpactReport(data: {
  model: string
  column?: string
  changeType: string
  direct: DownstreamModel[]
  transitive: DownstreamModel[]
  affectedTestCount: number
  totalModels: number
  /** Exposures (dashboards) on the model or anything downstream of it. */
  exposures?: ColumnReachExposure[]
  /** Why exposures could not be read, when reading them failed. */
  exposuresError?: string
  /** Downstream models that read the column, when one was given and traced. */
  columnReach?: ColumnReach
  /** Why the column could not be traced, when tracing failed. */
  columnReachError?: string
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

  // Column reach: the downstream models whose SQL reads the column
  if (data.column && data.columnReach) {
    const reach = data.columnReach
    const dashboards = reach.exposures.length
    lines.push(
      // Stopped early: the counts are lower bounds, and exposures past the stop may read the column too.
      `Column Reach: ${data.model}.${data.column} is read by ${reach.truncated ? "at least " : ""}${reach.models.length} model${reach.models.length === 1 ? "" : "s"} and ${reach.truncated ? "at least " : ""}${dashboards} exposure${dashboards === 1 ? "" : "s"}` +
        `${reach.uncertain.length ? `; ${reach.uncertain.length} more may read it` : ""}` +
        `${reach.untraced.length ? `; ${reach.untraced.length} could not be traced` : ""}${reach.truncated ? " (stopped early)" : ""}`,
    )
    lines.push("".padEnd(40, "-"))
    for (const m of reach.models) lines.push(`  ${m.name}${m.columns.length ? ` → ${m.columns.join(", ")}` : ""}`)
    for (const e of reach.exposures) lines.push(`  ◆ ${e.label} [${e.type}]`)
    for (const m of reach.uncertain) lines.push(`  ? ${m.name}: ${m.reason}`)
    for (const e of reach.uncertain_exposures) lines.push(`  ? ◆ ${e.label} [${e.type}] on a model that may read it`)
    for (const m of reach.untraced) lines.push(`  ! ${m.name} not traced: ${m.reason}`)
    lines.push("")
  }

  if (data.column && data.columnReachError) {
    lines.push(`Column Reach: not traced (${data.columnReachError}); the model-level impact above stands`)
    lines.push("")
  }

  // Exposures on anything affected, less those the column reach block already listed
  const listed = new Set(
    [...(data.columnReach?.exposures ?? []), ...(data.columnReach?.uncertain_exposures ?? [])].map((e) => e.unique_id),
  )
  const others = (data.exposures ?? []).filter((e) => !listed.has(e.unique_id))
  if (others.length > 0) {
    // When column reach stopped early, the rest are unchecked rather than known not to read the column.
    lines.push(`${data.columnReach ? (data.columnReach.truncated ? "Other exposures (column reach stopped before checking them)" : "Other exposures") : "Exposures"} (${others.length})`)
    lines.push("".padEnd(40, "-"))
    for (const e of others) lines.push(`  ${e.label} [${e.type}]`)
    lines.push("")
  }
  if (data.exposuresError) {
    lines.push(`Exposures: not read (${data.exposuresError.replace(/\r?\n/g, " ")})`)
    lines.push("")
  }

  // Affected tests
  if (data.affectedTestCount > 0) {
    lines.push(`Affected tests: ${data.affectedTestCount}`)
    lines.push("".padEnd(40, "-"))
    lines.push(
      data.affectedTestCount === 1
        ? "  Run `dbt test` to verify this test still passes after this change."
        : `  Run \`dbt test\` to verify these ${data.affectedTestCount} tests still pass after this change.`,
    )
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
