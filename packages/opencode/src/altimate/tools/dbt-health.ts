import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import z from "zod"
import { Tool } from "../../tool/tool"
import { dbtAdapterFor } from "./dbt-adapter-access"

/** One DataPilot finding for a model. */
export interface HealthInsight {
  uniqueId: string
  path: string
  name: string
  severity: string
  message: string
  recommendation: string
}

/** Test seams. */
export const dbtHealthInternals = {
  /** How long the DataPilot run may take. */
  runTimeoutMs: 300_000,
  /** Runs `python -c <script> <args...>` and returns its stdout; replaced in tests. */
  runPython: (python: string, script: string, args: string[], cwd: string, signal: AbortSignal) =>
    new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = execFile(
        python,
        ["-c", script, ...args],
        { cwd, signal, timeout: dbtHealthInternals.runTimeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code
          if (error && typeof code !== "number") return reject(error)
          resolve({ stdout, stderr, code: typeof code === "number" ? code : 0 })
        },
      )
      child.stdin?.end()
    }),
  /** The Python the project's dbt runs under. */
  discoverPython: async (root: string) => (await import("../../../../dbt-tools/src/config")).discoverPython(root),
}

// DataPilot is called the way dbt-integration's `project_healthcheck` calls it (Manual config: a file
// path, or none for the defaults). dbt-integration's own healthcheck entry point isn't implemented by
// any of its integrations, and its `All` mode would run `dbt docs generate`.
const SCRIPT = `
import json, sys, logging
try:
    from datapilot.config.config import load_config
    from datapilot.core.platforms.dbt.constants import MODEL
    from datapilot.core.platforms.dbt.executor import DBTInsightGenerator
    from datapilot.core.platforms.dbt.utils import load_catalog, load_manifest
except ImportError as e:
    print(json.dumps({"error": "missing_datapilot", "detail": str(e)}))
    sys.exit(0)
manifest_path, catalog_path, config_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    logging.disable(logging.CRITICAL)
    config = load_config(config_path) if config_path else None
    generator = DBTInsightGenerator(
        manifest=load_manifest(manifest_path),
        catalog=load_catalog(catalog_path) if catalog_path else None,
        config=config,
    )
    reports = generator.run()
    out = {k: [json.loads(i.json()) for i in v] for k, v in reports[MODEL].items()}
    print(json.dumps({"model_insights": out}))
except Exception as e:
    print(json.dumps({"error": "failed", "detail": str(e)}))
`

/** Flattens DataPilot's `model_insights` ({ uniqueId: [response] }) into one list. */
export function flattenInsights(modelInsights: unknown): HealthInsight[] {
  const out: HealthInsight[] = []
  if (!modelInsights || typeof modelInsights !== "object") return out
  for (const [uniqueId, list] of Object.entries(modelInsights as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const r = item as {
        unique_id?: string
        original_file_path?: string
        path?: string
        severity?: string
        insight?: { name?: string; message?: string; recommendation?: string }
      }
      out.push({
        uniqueId: r.unique_id ?? uniqueId,
        path: r.original_file_path ?? r.path ?? "",
        name: r.insight?.name ?? "",
        severity: r.severity ?? "",
        message: r.insight?.message ?? "",
        recommendation: r.insight?.recommendation ?? "",
      })
    }
  }
  return out
}

function failure(title: string, output: string, extra: Record<string, unknown> = {}) {
  return { title: `dbt_health: ${title}`, metadata: { success: false, insights: [], ...extra }, output }
}

export const DbtHealthTool = Tool.define("dbt_health", {
  description:
    "DataPilot project health insights for the models of the dbt project (hard-coded references, missing tests or documentation, naming and structure issues, and so on). Uses the project's dbt integration (starts it, so it needs write permission) for a fresh manifest, then runs DataPilot (the `altimate-datapilot-cli` Python package, which must be installed in the project's Python) over the manifest, and the catalog when target/catalog.json exists. Returns `insights`: uniqueId, path, name, severity, message and recommendation for each.",
  parameters: z.object({
    config_path: z
      .string()
      .optional()
      .describe("DataPilot config file (its `disabled_insights` and thresholds); default: DataPilot's defaults"),
  }),
  async execute(args, ctx) {
    const access = await dbtAdapterFor(ctx)
    if (!access.adapter) return failure("unavailable", `dbt_health can't run: ${access.reason}.`, { refusal: access.refusal })
    const adapter = access.adapter
    const { getDbtProjectRoot } = await import("../native/connections/register")
    const root: string | undefined = (typeof adapter.getProjectRoot === "function" ? adapter.getProjectRoot() : undefined) ?? (await getDbtProjectRoot())
    if (!root) return failure("unavailable", "dbt_health can't run: no dbt project here.")
    const manifest: string =
      (typeof adapter.getManifestPath === "function" ? adapter.getManifestPath() : undefined) ?? path.join(root, "target", "manifest.json")
    if (!fs.existsSync(manifest)) return failure("no manifest", `dbt_health can't run: no manifest at ${manifest}; run dbt parse or dbt compile first.`)
    const catalogFile = path.join(path.dirname(manifest), "catalog.json")
    const catalog = fs.existsSync(catalogFile) ? catalogFile : ""
    let configPath = ""
    if (args.config_path) {
      configPath = path.resolve(root, args.config_path)
      if (!fs.existsSync(configPath)) return failure("no config", `dbt_health can't run: no DataPilot config at ${configPath}.`)
    }
    const python = await dbtHealthInternals.discoverPython(root)
    let run: { stdout: string; stderr: string; code: number | null }
    try {
      run = await dbtHealthInternals.runPython(python, SCRIPT, [manifest, catalog, configPath], root, ctx.abort)
    } catch (e) {
      if (ctx.abort.aborted) throw e
      return failure("failed", `dbt_health couldn't run ${python}: ${e instanceof Error ? e.message : String(e)}`)
    }
    // DataPilot may log to stdout: the answer is the last line that parses as an object.
    let parsed: { error?: string; detail?: string; model_insights?: unknown } | undefined
    for (const line of run.stdout.split("\n").reverse()) {
      try {
        const value = JSON.parse(line)
        if (value && typeof value === "object") {
          parsed = value
          break
        }
      } catch {}
    }
    if (!parsed)
      return failure("failed", `DataPilot gave no answer (exit ${run.code}).${run.stderr ? `\n${run.stderr.slice(-2000)}` : ""}`)
    if (parsed.error === "missing_datapilot")
      return failure(
        "datapilot missing",
        `DataPilot isn't installed in ${python}. Install the \`altimate-datapilot-cli\` package into the dbt project's Python (for example \`${python} -m pip install altimate-datapilot-cli\`) and run again.`,
        { missing: "altimate-datapilot-cli", python },
      )
    if (parsed.error) return failure("failed", `DataPilot failed: ${parsed.detail ?? parsed.error}`)
    const insights = flattenInsights(parsed.model_insights)
    const lines = insights.map((i) => `- ${i.severity} ${i.name} · ${i.uniqueId} (${i.path}): ${i.message}${i.recommendation ? ` → ${i.recommendation}` : ""}`)
    return {
      title: `dbt_health: ${insights.length} insight${insights.length === 1 ? "" : "s"}`,
      metadata: { success: true, insights, catalog: !!catalog },
      output: insights.length ? lines.join("\n") : "No health insights.",
    }
  },
})
