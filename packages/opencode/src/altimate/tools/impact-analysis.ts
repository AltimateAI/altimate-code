// altimate_change - Impact analysis tool for dbt DAG-aware change assessment
//
// Combines dbt manifest parsing with column-level lineage to show downstream
// impact of model/column changes across the entire DAG.
import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"
import { guardExternalFile, isPermissionError } from "./schema-path-guard"
import type { Telemetry } from "../telemetry"

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
    model: z.string().describe("dbt model name to analyze impact for (e.g., 'stg_orders', 'dim_customers')"),
    column: z
      .string()
      .optional()
      .describe("Specific column to trace impact for. If omitted, analyzes model-level impact."),
    change_type: z.enum(["remove", "rename", "retype", "add", "modify"]).describe("Type of change being considered"),
    manifest_path: z.string().optional().default("target/manifest.json").describe("Path to dbt manifest.json file"),
    dialect: z.string().optional().default("snowflake").describe("SQL dialect for lineage analysis"),
  }),
  async execute(args, ctx) {
    try {
      // Manifest paths outside the project require the external_directory gate,
      // same as the other dbt readers. Relative paths resolve against the
      // PROJECT directory (mirrors read.ts), and the gated path is what's read.
      const manifestPath = (await guardExternalFile(ctx, args.manifest_path)) ?? args.manifest_path
      // Step 1: Parse the dbt manifest to get the full DAG
      const manifest = await Dispatcher.call("dbt.manifest", { path: manifestPath })

      if (!manifest.models || manifest.models.length === 0) {
        return {
          title: "Impact: NO MANIFEST",
          metadata: { success: false },
          output: `No models found in manifest at ${args.manifest_path}. Run \`dbt compile\` first to generate the manifest.`,
        }
      }

      // Step 2: Find the target model(s). Computed ONCE — the not-found check
      // and the affected-id set both derive from this list, so the matching
      // rule cannot silently drift between them.
      const targetMatches = manifest.models.filter(
        (m: { name: string; unique_id?: string }) =>
          m.name === args.model || m.name.endsWith(`.${args.model}`) || m.unique_id === args.model,
      )

      if (targetMatches.length === 0) {
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

      // Step 4: Count only tests that reference the target model(s) or their
      // downstream models. Use the unique_ids CARRIED BY the traversal — a
      // name-keyed map would overwrite package-qualified models sharing a name
      // and silently drop the overwritten branch's tests. All same-named
      // targets count (the traversal seeded all of them).
      const targetIds = targetMatches.map((m: { unique_id?: string }) => m.unique_id).filter(Boolean)
      const affectedModelIds = new Set([...targetIds, ...downstream.map((d) => d.unique_id).filter(Boolean)])
      const affectedTests = (manifest.tests ?? []).filter((t) =>
        t.depends_on?.some((dep) => affectedModelIds.has(dep)),
      )
      const affectedTestCount = affectedTests.length

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
      // Column-level tracing here is BEST-EFFORT: it runs lineage on a
      // synthetic `SELECT *` without manifest-compiled downstream SQL, so it
      // cannot authoritatively identify affected downstream columns. Say so —
      // silently presenting the model-level DAG as the column's blast radius
      // would overstate the evidence. dbt_lineage is the authoritative tool.
      const columnCaveat = args.column
        ? "\n\nNote: column-level impact is best-effort (no compiled downstream SQL inspected). For authoritative column tracing, use `dbt_lineage` with the manifest."
        : ""
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
          column_impact: columnImpact.length,
          has_schema: false,
          ...(findings.length > 0 && { findings }),
        },
        output: output + columnCaveat,
      }
    } catch (e) {
      if (isPermissionError(e)) throw e
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
  /** dbt unique_id when the manifest provides one — callers must use this,
   *  not `name`, when collecting affected resources (names can collide across
   *  packages). */
  unique_id?: string
  depth: number
  materialized?: string
  path: string[]
}

export function findDownstream(
  targetName: string,
  models: Array<{ name: string; depends_on: string[]; materialized?: string; unique_id?: string }>,
): DownstreamModel[] {
  // Traverse by dbt unique_id so package-qualified models sharing a `name`
  // (model.pkg_a.orders vs model.pkg_b.orders) are never conflated — names are
  // resolved only for display. Models without a unique_id (minimal fixtures,
  // older manifests) fall back to name-suffix matching for their edges.
  const uid = (m: { name: string; unique_id?: string }) => m.unique_id ?? `name:${m.name}`
  const results: DownstreamModel[] = []

  const dependsOn = (model: { depends_on: string[] }, parent: { name: string; unique_id?: string }) =>
    model.depends_on.some((d) =>
      parent.unique_id ? d === parent.unique_id : d.split(".").pop() === parent.name,
    )

  // Entry by name (the tool's public argument) or exact unique_id; multiple
  // same-named targets ALL seed the traversal (full blast radius for a bare
  // name; scoped when a unique_id is given).
  const targets = models.filter((m) => m.name === targetName || m.unique_id === targetName)
  const seeds: Array<{ name: string; unique_id?: string }> = targets.length ? targets : [{ name: targetName }]

  // BFS from all seeds simultaneously so `depth` is the SHORTEST distance from
  // any seed — a DFS with a shared visited set would label a direct dependent
  // "transitive" whenever an earlier seed reached it first via a longer path,
  // with results depending on manifest order.
  const visited = new Set<string>(seeds.map(uid))
  const paths = new Map<string, string[]>(seeds.map((s) => [uid(s), [targetName]]))
  let frontier = seeds
  let depth = 1
  while (frontier.length > 0) {
    const next: Array<{ name: string; unique_id?: string; depends_on: string[]; materialized?: string }> = []
    for (const model of models) {
      if (visited.has(uid(model))) continue
      const parent = frontier.find((p) => dependsOn(model, p))
      if (!parent) continue
      visited.add(uid(model))
      const newPath = [...(paths.get(uid(parent)) ?? [targetName]), model.name]
      paths.set(uid(model), newPath)
      results.push({
        name: model.name,
        unique_id: model.unique_id,
        depth,
        materialized: model.materialized,
        path: newPath,
      })
      next.push(model)
    }
    frontier = next
    depth++
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
