import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import z from "zod"
import { Tool } from "../../tool/tool"
import { dbtAdapterInternals } from "../native/connections/register"
import { dbtAdapterFor } from "./dbt-adapter-access"

/** One DataPilot finding for a model. */
export interface HealthInsight {
  uniqueId: string
  path: string
  name: string
  severity: string
  message: string
  recommendation: string
  /** The model's SQL file and its properties file, absolute; empty when the model isn't the project's own package's. */
  file: string
  properties: string
}

/** What the script says about each model node of the manifest. */
interface NodeFiles {
  package?: string
  file?: string
  patch?: string
}

/** The most insights the text of the answer lists; the structured result carries every one. */
const LISTED_LINES = 100

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
          if ((error as { killed?: boolean } | null)?.killed)
            return reject(new Error(`DataPilot didn't finish within ${dbtHealthInternals.runTimeoutMs / 1000} s`))
          if (error && typeof code !== "number") return reject(error)
          resolve({ stdout, stderr, code: typeof code === "number" ? code : 0 })
        },
      )
      child.stdin?.end()
    }),
  /** The Python found for a project when the dbt config names none. */
  discoverPython: async (root: string) => (await import("../../../../dbt-tools/src/config")).discoverPython(root),
}

/** The Python dbt runs under: the one the dbt config names (the adapter uses it), else one found for the project. */
async function pythonFor(root: string): Promise<string> {
  const { read } = await import("../../../../dbt-tools/src/config")
  const config = (dbtAdapterInternals.readConfig ? await dbtAdapterInternals.readConfig() : await read()) as { pythonPath?: unknown } | undefined
  return typeof config?.pythonPath === "string" && config.pythonPath ? config.pythonPath : dbtHealthInternals.discoverPython(root)
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
    # Only DataPilot itself missing is "not installed"; a name missing from it, or one of its own imports failing, is a failure.
    kind = "missing_datapilot" if isinstance(e, ModuleNotFoundError) and getattr(e, "name", None) == "datapilot" else "failed"
    print(json.dumps({"error": kind, "detail": str(e)}))
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
    with open(manifest_path) as f:
        raw = json.load(f)
    nodes = {
        k: {"package": n.get("package_name"), "file": n.get("original_file_path"), "patch": n.get("patch_path")}
        for k, n in raw.get("nodes", {}).items()
        if k in out
    }
    print(json.dumps({"model_insights": out, "nodes": nodes, "project": (raw.get("metadata") or {}).get("project_name")}))
except Exception as e:
    print(json.dumps({"error": "failed", "detail": str(e)}))
`

/** A manifest `patch_path` (`package://models/schema.yml`) as the path inside its package. */
function patchFile(patch: string | undefined): string {
  return patch ? patch.replace(/^[^:/]*:\/\//, "") : ""
}

/**
 * Flattens DataPilot's `model_insights` ({ uniqueId: [response] }) into one list. A model of the project's
 * own package gets its files resolved against `root`; another package's gets none.
 */
export function flattenInsights(modelInsights: unknown, root = "", nodes: Record<string, NodeFiles> = {}, project?: string): HealthInsight[] {
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
      const id = r.unique_id ?? uniqueId
      const node = nodes[id]
      const own = !!root && !!node && !!project && node.package === project
      out.push({
        file: own && node.file ? path.resolve(root, node.file) : "",
        properties: own && patchFile(node.patch) ? path.resolve(root, patchFile(node.patch)) : "",
        uniqueId: id,
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
    "DataPilot project health insights for the models of the dbt project (hard-coded references, missing tests or documentation, naming and structure issues, and so on). Uses the project's dbt integration (starts it, so it needs write permission) for a fresh manifest, then runs DataPilot (the `altimate-datapilot-cli` Python package, which must be installed in the project's Python) over the manifest, and the catalog when target/catalog.json exists. Returns `insights`: uniqueId, path, name, severity, message and recommendation for each, plus the model's absolute `file` and `properties` file for the project's own models.",
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
    // The adapter's watcher rebuilds the manifest a moment after an edit, and `parseManifest` only reads the
    // file: rebuild now and wait for it, so the run reads the project as it is. A rebuild that throws stops
    // the run; one that leaves only the last good manifest is said so in the answer.
    let stale: { message: string; manifest_path?: string; written_at?: string; age_seconds?: number } | undefined
    if (typeof adapter.parseManifest === "function") {
      try {
        if (typeof adapter.rebuildManifest === "function") await adapter.rebuildManifest()
        const parsed = await adapter.parseManifest()
        if (parsed?.stale) {
          // The same shape the other dbt tools give a stale manifest.
          const writtenAt = typeof parsed.stale.writtenAt === "number" ? parsed.stale.writtenAt : undefined
          stale = {
            message: `The dbt project check failed, so these insights come from the manifest of the last successful parse${writtenAt === undefined ? "" : `, written ${new Date(writtenAt).toISOString()}`}. They may not match the project as it is now.`,
            manifest_path: parsed.stale.manifestPath,
            written_at: writtenAt === undefined ? undefined : new Date(writtenAt).toISOString(),
            age_seconds: writtenAt === undefined ? undefined : Math.max(0, Math.round((Date.now() - writtenAt) / 1000)),
          }
        }
      } catch (e) {
        if (ctx.abort.aborted) throw e
        return failure("parse failed", `dbt_health can't run: dbt couldn't parse the project: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
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
    let python: string
    try {
      python = await pythonFor(root)
    } catch (e) {
      if (ctx.abort.aborted) throw e
      return failure("failed", `dbt_health couldn't find a Python to run DataPilot: ${e instanceof Error ? e.message : String(e)}`)
    }
    let run: { stdout: string; stderr: string; code: number | null }
    try {
      run = await dbtHealthInternals.runPython(python, SCRIPT, [manifest, catalog, configPath], root, ctx.abort)
    } catch (e) {
      if (ctx.abort.aborted) throw e
      return failure("failed", `dbt_health couldn't run ${python}: ${e instanceof Error ? e.message : String(e)}`)
    }
    // DataPilot may log to stdout: the answer is the last line that parses as the script's answer.
    let parsed: { error?: string; detail?: string; model_insights?: unknown; nodes?: Record<string, NodeFiles>; project?: string } | undefined
    for (const line of run.stdout.split("\n").reverse()) {
      try {
        const value = JSON.parse(line)
        if (value && typeof value === "object" && !Array.isArray(value) && ("error" in value || "model_insights" in value)) {
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
    if (run.code !== 0 || !parsed.model_insights || typeof parsed.model_insights !== "object")
      return failure("failed", `DataPilot gave no insights (exit ${run.code}).${run.stderr ? `\n${run.stderr.slice(-2000)}` : ""}`)
    // Paths from the folder as the system names it (`/tmp` is `/private/tmp` on macOS), the way an editor's cwd is.
    let realRoot = root
    try {
      realRoot = fs.realpathSync(root)
    } catch {}
    const insights = flattenInsights(parsed.model_insights, realRoot, parsed.nodes, parsed.project)
    const lines = insights.slice(0, LISTED_LINES).map((i) => `- ${i.severity} ${i.name} · ${i.uniqueId} (${i.path}): ${i.message}${i.recommendation ? ` → ${i.recommendation}` : ""}`)
    return {
      title: `dbt_health: ${insights.length} insight${insights.length === 1 ? "" : "s"}`,
      metadata: { success: true, insights, catalog: !!catalog, ...(stale ? { stale_manifest: stale } : {}) },
      output: [
        stale?.message,
        insights.length ? lines.join("\n") : "No health insights.",
        insights.length > LISTED_LINES ? `…and ${insights.length - LISTED_LINES} more insights, all in the result's \`insights\`.` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    }
  },
})
