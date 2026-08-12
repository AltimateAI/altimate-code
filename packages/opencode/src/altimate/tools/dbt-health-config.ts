import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import z from "zod"
import { Tool } from "../../tool/tool"
import { Dispatcher } from "../native"

/** Relative path (from the dbt project root) where the inferred config is written. */
export const DBT_HEALTH_CONFIG_RELPATH = ".altimate/dbt-health.yml"

export const DbtHealthConfigTool = Tool.define("dbt_health_config", {
  description:
    "Deterministically infer a dbt health-check config from a dbt project's EXISTING conventions (modal tags/meta keys/tests, configured schemas & databases, naming contracts, distribution-ratcheted thresholds) and write it to <project_dir>/.altimate/dbt-health.yml. This activates the config-driven governance checks (which are no-ops until configured). Per-project: each dbt project gets its own config file. Reproducible — no LLM, same project always yields the same file.",
  parameters: z.object({
    project_dir: z.string().describe("Path to the dbt project root (the directory containing dbt_project.yml)"),
    write: z
      .boolean()
      .optional()
      .describe("Write the config to <project_dir>/.altimate/dbt-health.yml (default true). If false, only return the YAML."),
  }),
  async execute(args, _ctx) {
    const result = await Dispatcher.call("altimate_core.dbt_health_infer_config", {
      project_dir: args.project_dir,
    })

    if (!result.success) {
      const error = result.error ?? "unknown error"
      return {
        title: "dbt health config: ERROR",
        metadata: { error },
        output: `Failed to infer dbt health config: ${error}`,
      }
    }

    const yaml = String((result.data as { config?: unknown }).config ?? "")
    const outPath = `${args.project_dir.replace(/\/+$/, "")}/${DBT_HEALTH_CONFIG_RELPATH}`

    let written = false
    if (args.write !== false) {
      await mkdir(dirname(outPath), { recursive: true })
      await Bun.write(outPath, yaml)
      written = true
    }

    const checkCount = (yaml.match(/^ {2}\S/gm) ?? []).length
    return {
      title: written
        ? `dbt health config written (${checkCount} checks tuned) → ${outPath}`
        : `dbt health config inferred (${checkCount} checks tuned)`,
      metadata: { path: outPath, written, project_dir: args.project_dir },
      output: written
        ? `Wrote inferred config to ${outPath}:\n\n${yaml}`
        : `Inferred config (not written):\n\n${yaml}`,
    }
  },
})
