import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

/** A single finding returned by `altimate_core.dbt_project_health` (Rust `HealthFinding`). */
interface HealthFinding {
  code: string
  alias: string
  resource_type: "model" | "source" | "exposure" | "macro" | "project"
  unique_id?: string
  file?: string
  severity: "error" | "warning" | "info"
  message: string
  recommendation?: string
  reason_to_flag?: string
  metadata?: unknown
}

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 }

export const DbtProjectHealthTool = Tool.define("dbt_project_health", {
  description:
    "Run dbt project health checks (governance, modelling, documentation, tests, sources) directly against a dbt project's files — no compiled manifest.json required. Reads .sql models (via the dbt Jinja AST parser), schema.yml properties and dbt_project.yml. Optionally uses a catalog.json for column-level checks; otherwise columns are inferred from the SQL parser.",
  parameters: z.object({
    project_dir: z.string().describe("Path to the dbt project root (the directory containing dbt_project.yml)"),
    config_path: z
      .string()
      .optional()
      .describe("Optional path to a JSON health-check config (disabled checks, severity overrides, options)"),
    catalog_path: z
      .string()
      .optional()
      .describe("Optional path to a dbt catalog.json to power column-aware checks"),
  }),
  async execute(args, _ctx) {
    // Explicit config_path wins; otherwise auto-discover a per-project inferred config
    // at <project_dir>/.altimate/dbt-health.{yml,yaml,json} (YAML or JSON both parse).
    let config_json: string | undefined
    const candidates = args.config_path
      ? [args.config_path]
      : [
          `${args.project_dir.replace(/\/+$/, "")}/.altimate/dbt-health.yml`,
          `${args.project_dir.replace(/\/+$/, "")}/.altimate/dbt-health.yaml`,
          `${args.project_dir.replace(/\/+$/, "")}/.altimate/dbt-health.json`,
        ]
    for (const candidate of candidates) {
      const file = Bun.file(candidate)
      if (await file.exists()) {
        config_json = await file.text()
        break
      }
    }

    const result = await Dispatcher.call("altimate_core.dbt_project_health", {
      project_dir: args.project_dir,
      config_json,
      catalog_path: args.catalog_path,
    })

    if (!result.success) {
      const error = result.error ?? "unknown error"
      return {
        title: "dbt health: ERROR",
        metadata: { error },
        output: `Failed to run dbt health checks: ${error}`,
      }
    }

    const findings = ((result.data.findings as HealthFinding[] | undefined) ?? []).slice()
    findings.sort(
      (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) || a.code.localeCompare(b.code),
    )

    const counts = { error: 0, warning: 0, info: 0 } as Record<string, number>
    for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1

    return {
      title: `dbt health: ${findings.length} finding(s) — ${counts.error} error, ${counts.warning} warning, ${counts.info} info`,
      metadata: {
        finding_count: findings.length,
        error_count: counts.error,
        warning_count: counts.warning,
        info_count: counts.info,
      },
      output: formatFindings(findings),
    }
  },
})

function formatFindings(findings: HealthFinding[]): string {
  if (findings.length === 0) return "✓ No dbt health issues found."
  const lines: string[] = []
  for (const f of findings) {
    const where = f.file ? ` (${f.file})` : f.unique_id ? ` (${f.unique_id})` : ""
    lines.push(`[${f.severity.toUpperCase()}] ${f.code} ${f.alias}${where}`)
    lines.push(`  ${f.message}`)
    if (f.recommendation) lines.push(`  → ${f.recommendation}`)
  }
  return lines.join("\n")
}
