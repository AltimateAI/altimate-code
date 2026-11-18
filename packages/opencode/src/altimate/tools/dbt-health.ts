import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import z from "zod"
import { Tool } from "../../tool/tool"
import { dbtAdapterInternals } from "../native/connections/register"
import { dbtAdapterFor } from "./dbt-adapter-access"
import { dbtProjectName } from "../review/compiled"

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

/** The most bytes of insights the structured result carries. */
export const RESULT_BYTES = 2 * 1024 * 1024

/** A failure of the wait for a rebuild, as opposed to one of the parse. */
function rebuildWait(message: string) {
  return Object.assign(new Error(message), { name: "RebuildWaitError" })
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
        ["-E", "-c", script, ...args],
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
  /** How long a call waits for the manifest rebuild. The rebuild itself goes on; a call that times out abandons it, and no other rebuild starts until it has finished. */
  rebuildTimeoutMs: 120_000,
  /** The Python found for a project when the dbt config names none. */
  discoverPython: async (root: string) => (await import("../../../../dbt-tools/src/config")).discoverPython(root),
}

/**
 * The rebuilds of an adapter: one running and at most one queued. A call that arrives while one runs may have
 * edited files after it read them, so it waits for a rebuild that starts after it arrived; calls that
 * arrive in the same window share that one.
 */
type Slot = { running: Promise<unknown>; queued?: Promise<unknown>; waiters?: { count: number }; abandoned?: boolean }
const rebuilding = new WeakMap<object, Slot>()
/** The rebuild a timed-out call abandoned while it was still running: no other starts until it settles, so two parses never write target/ at once. */
const abandonedRunning = new WeakMap<object, Promise<unknown>>()

function trackRebuild(adapter: object, slot: Slot) {
  const next = () => {
    if (rebuilding.get(adapter) !== slot) return
    if (slot.queued) {
      slot.running = slot.queued
      slot.queued = undefined
      trackRebuild(adapter, slot)
    } else rebuilding.delete(adapter)
  }
  slot.running.then(next, next)
}

/** Waits for a manifest rebuild that starts no earlier than this call, bounded by a timeout and the call's abort. */
async function rebuildManifest(adapter: { rebuildManifest: () => unknown }, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted()
  // The rebuild's own start time, taken when it actually starts: a queued one starts after the one before it.
  const start = async () => {
    const at = Date.now()
    await adapter.rebuildManifest()
    return at
  }
  let slot = rebuilding.get(adapter)
  if (!slot && abandonedRunning.has(adapter))
    throw rebuildWait("a manifest rebuild that timed out is still running: try again once it has finished")
  let shared: Promise<unknown>
  // The calls waiting on the queued rebuild: it starts only if one of them still wants it.
  let waiters: { count: number } | undefined
  if (!slot) {
    shared = Promise.resolve().then(start)
    slot = { running: shared }
    rebuilding.set(adapter, slot)
    trackRebuild(adapter, slot)
  } else {
    const owner = slot
    if (!owner.queued) {
      const mine = { count: 0 }
      owner.waiters = mine
      // A slot a timed-out call abandoned starts no rebuild of its own, nor does one every waiter has left.
      owner.queued = owner.running.catch(() => {}).then(() => {
        if (owner.abandoned) throw rebuildWait("the manifest rebuild it waited for was abandoned after a timeout")
        if (mine.count === 0) throw rebuildWait("the manifest rebuild it waited for was cancelled")
        return start()
      })
      owner.queued.catch(() => {})
    }
    waiters = owner.waiters
    waiters!.count++
    shared = owner.queued
  }
  let stop = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason)
    signal.addEventListener("abort", stop, { once: true })
    timer = setTimeout(() => {
      // A rebuild that never settles must not hold the queue: drop this slot; no other rebuild starts until the abandoned one ends.
      if (rebuilding.get(adapter) === slot) {
        slot.abandoned = true
        rebuilding.delete(adapter)
        const running = slot.running
        abandonedRunning.set(adapter, running)
        const clear = () => {
          if (abandonedRunning.get(adapter) === running) abandonedRunning.delete(adapter)
        }
        running.then(clear, clear)
      }
      reject(rebuildWait(`the manifest rebuild didn't finish within ${dbtHealthInternals.rebuildTimeoutMs / 1000} s`))
    }, dbtHealthInternals.rebuildTimeoutMs)
  })
  waited.catch(() => {})
  const startedAt = (await Promise.race([shared, waited]).finally(() => {
    if (waiters) waiters.count--
    signal.removeEventListener("abort", stop)
    clearTimeout(timer)
  })) as number
  return startedAt
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
import sys, os
# The interpreter ignores PYTHONPATH (-E) and the filter below keeps the working folder off the path; the
# user site stays, so a user-installed (pip --user) DataPilot is found.
sys.path = [p for p in sys.path if p not in ("", os.getcwd())]
import json, logging
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
try:
    from importlib.metadata import version as _version
    datapilot_version = _version("altimate-datapilot-cli")
except Exception:
    datapilot_version = None
manifest_path, catalog_path, config_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    logging.disable(logging.CRITICAL)
    config = load_config(config_path) if config_path else None
    # The manifest is read once, so the insights and the file paths come from the same version of it.
    import tempfile
    with open(manifest_path, "rb") as f:
        data = f.read()
    raw = json.loads(data)
    with tempfile.TemporaryDirectory() as tmp:
        snapshot = os.path.join(tmp, "manifest.json")
        with open(snapshot, "wb") as f:
            f.write(data)
        manifest = load_manifest(snapshot)
    generator = DBTInsightGenerator(
        manifest=manifest,
        catalog=load_catalog(catalog_path) if catalog_path else None,
        config=config,
    )
    reports = generator.run()
    out = {k: [json.loads(i.json()) for i in v] for k, v in reports.get(MODEL, {}).items()}
    nodes = {
        k: {"package": n.get("package_name"), "file": n.get("original_file_path"), "patch": n.get("patch_path")}
        for k, n in raw.get("nodes", {}).items()
        if k in out
    }
    print(json.dumps({"model_insights": out, "nodes": nodes, "project": (raw.get("metadata") or {}).get("project_name")}))
except Exception as e:
    print(json.dumps({"error": "failed", "detail": str(e), "version": datapilot_version}))
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

const FAILURE_CHARS = 2000
const LINE_CHARS = 500
// One diagnostic's share of the parse-failure text, so a long first error does not hide the rest.
const ERROR_CHARS = 400
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text)

function failure(title: string, output: string, extra: Record<string, unknown> = {}) {
  return { title: `dbt_health: ${title}`, metadata: { success: false, insights: [], error: output, ...extra }, output }
}

export const DbtHealthTool = Tool.define("dbt_health", {
  description:
    "DataPilot project health insights for the models of the dbt project (hard-coded references, missing tests or documentation, naming and structure issues, and so on). Uses the project's dbt integration (starts it, so it needs write permission) for a fresh manifest, then runs DataPilot (the `altimate-datapilot-cli` Python package, which must be installed in the project's Python) over the manifest, and the catalog when target/catalog.json exists. Returns `insights`: uniqueId, path, name, severity, message and recommendation for each, plus the model's absolute `file` and `properties` file for the project's own models. When dbt can't parse the project the answer is a failure with the parse errors (no insights from the last manifest); a failed project check alone is answered from the last good manifest, labelled `stale_manifest`. A very large result is cut at a byte limit: `truncated` is then true, and `total` counts every insight.",
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
    let rebuiltAt: number | undefined
    if (typeof adapter.parseManifest === "function") {
      try {
        if (typeof adapter.rebuildManifest === "function") {
          rebuiltAt = await rebuildManifest(adapter, ctx.abort)
        }
        // A rebuild that fails to compile returns normally and leaves the last manifest: its diagnostics say so.
        // The adapter's own getDiagnostics() answers nothing; the integration beneath it holds them.
        const source = typeof adapter.currentIntegration?.getDiagnostics === "function" ? adapter.currentIntegration : adapter
        const diagnostics = (typeof source.getDiagnostics === "function" ? source.getDiagnostics() : undefined)?.rebuildManifestDiagnostics
        // A parse that succeeded can still report warnings (deprecations, unused config): only errors stop the run.
        const errors = Array.isArray(diagnostics)
          ? diagnostics.filter((d: { severity?: unknown }) => !(typeof d?.severity === "string" && /^(warn|info|hint)/i.test(d.severity)))
          : []
        if (errors.length > 0)
          return failure(
            "parse failed",
            `dbt_health can't run: dbt couldn't parse the project: ${clip(errors.map((d: { message?: string }) => d?.message && clip(d.message, ERROR_CHARS)).filter(Boolean).join("; ") || "the manifest rebuild failed", FAILURE_CHARS)}`,
          )
        const parsed = await adapter.parseManifest()
        if (parsed?.stale) {
          // The same shape the other dbt tools give a stale manifest.
          const writtenAt = typeof parsed.stale.writtenAt === "number" && Number.isFinite(parsed.stale.writtenAt) ? parsed.stale.writtenAt : undefined
          stale = {
            message: `The dbt project check failed, so these insights come from the manifest of the last successful parse${writtenAt === undefined ? "" : `, written ${new Date(writtenAt).toISOString()}`}. They may not match the project as it is now.`,
            manifest_path: parsed.stale.manifestPath,
            written_at: writtenAt === undefined ? undefined : new Date(writtenAt).toISOString(),
            age_seconds: writtenAt === undefined ? undefined : Math.max(0, Math.round((Date.now() - writtenAt) / 1000)),
          }
        }
      } catch (e) {
        if (ctx.abort.aborted) throw e
        const reason = e instanceof Error ? e.message : String(e)
        // The wait's own failures are not parse errors.
        return e instanceof Error && e.name === "RebuildWaitError"
          ? failure("rebuild unavailable", `dbt_health can't run: ${clip(reason, FAILURE_CHARS)}`)
          : failure("parse failed", `dbt_health can't run: dbt couldn't parse the project: ${clip(reason, FAILURE_CHARS)}`)
      }
    }
    let manifest: string =
      (typeof adapter.getManifestPath === "function" ? adapter.getManifestPath() : undefined) ?? path.join(root, "target", "manifest.json")
    // The manifest the adapter read when it fell back to the last good one may sit under a configured target-path.
    if (stale && typeof stale.manifest_path === "string" && stale.manifest_path) manifest = stale.manifest_path
    if (!fs.existsSync(manifest)) return failure("no manifest", `dbt_health can't run: no manifest at ${manifest}; run dbt parse or dbt compile first.`)
    // The adapter's own watcher can replace this rebuild with one of its own (the replaced one resolves
    // normally and writes nothing): a manifest older than the rebuild this call started is the last one.
    if (!stale && rebuiltAt !== undefined) {
      // The file can vanish between the check above and here (a concurrent rebuild, `dbt clean`): the note is advisory.
      let written: number | undefined
      try {
        written = fs.statSync(manifest).mtimeMs
      } catch {}
      // A completed rebuild writes the manifest after it started; the second absorbs a coarse file clock.
      if (written !== undefined && written < Math.floor(rebuiltAt / 1000) * 1000)
        stale = {
          message: "The manifest was not rewritten by this call's rebuild (another rebuild may have replaced it and still be running), so these insights may not match the project as it is now; run dbt_health again in a moment.",
          manifest_path: manifest,
          written_at: new Date(written).toISOString(),
          age_seconds: Math.max(0, Math.round((Date.now() - written) / 1000)),
        }
    }
    const catalogFile = path.join(path.dirname(manifest), "catalog.json")
    const catalog = fs.existsSync(catalogFile) ? catalogFile : ""
    let configPath = ""
    if (args.config_path) {
      configPath = path.resolve(root, args.config_path)
      // The config is read from the dbt project: a path outside it is refused before anything about it is checked.
      const rel = path.relative(root, configPath)
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
        return failure("config outside project", "dbt_health can't run: config_path must be inside the dbt project.")
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
    let parsed: { error?: string; detail?: string; model_insights?: unknown; nodes?: Record<string, NodeFiles>; project?: string; version?: string | null } | undefined
    let end = run.stdout.length
    while (end > 0 && !parsed) {
      const start = run.stdout.lastIndexOf("\n", end - 1) + 1
      const line = run.stdout.slice(start, end)
      end = start - 1
      try {
        const value = JSON.parse(line)
        if (value && typeof value === "object" && !Array.isArray(value) && ("error" in value || "model_insights" in value)) parsed = value
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
    if (parsed.error) {
      const detail = String(parsed.detail ?? parsed.error)
      const shown = clip(detail, FAILURE_CHARS)
      const version = parsed.version ? ` (altimate-datapilot-cli ${parsed.version})` : ""
      const hint = /validation error|invalid manifest/i.test(detail)
        ? `\nThe installed DataPilot${version} may be too old for this dbt version's manifest: upgrade it with \`${python} -m pip install -U altimate-datapilot-cli\`.`
        : ""
      return failure("failed", `DataPilot failed${version}: ${shown}${hint}`)
    }
    const insightsShape = (v: unknown) =>
      !!v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.values(v).every((list) => Array.isArray(list) && list.every((r) => !!r && typeof r === "object" && !Array.isArray(r)))
    if (run.code !== 0 || !insightsShape(parsed.model_insights))
      return failure("failed", `DataPilot gave no insights (exit ${run.code}).${run.stderr ? `\n${run.stderr.slice(-2000)}` : ""}`)
    // Paths from the folder as the system names it (`/tmp` is `/private/tmp` on macOS), the way an editor's cwd is.
    let realRoot = root
    try {
      realRoot = fs.realpathSync(root)
    } catch {}
    const all = flattenInsights(parsed.model_insights, realRoot, parsed.nodes, parsed.project ?? (await dbtProjectName(realRoot)))
    // The structured result is read by a plugin that accepts at most 4 MiB: keep it well under that.
    let bytes = 0
    let keep = 0
    for (const i of all) {
      bytes += Buffer.byteLength(JSON.stringify(i), "utf8") + 1
      if (bytes > RESULT_BYTES) break
      keep++
    }
    const insights = all.slice(0, keep)
    const truncated = keep < all.length
    const lines = insights.slice(0, LISTED_LINES).map((i) => clip(`- ${i.severity} ${i.name} · ${i.uniqueId} (${i.path}): ${i.message}${i.recommendation ? ` → ${i.recommendation}` : ""}`.replace(/\s*\n\s*/g, " "), LINE_CHARS))
    return {
      title: `dbt_health: ${all.length} insight${all.length === 1 ? "" : "s"}`,
      // `truncated` is always set: the tool wrapper's own output truncation must not mark a complete insight list as cut.
      metadata: { success: true, insights, catalog: !!catalog, truncated, ...(truncated ? { total: all.length } : {}), ...(stale ? { stale_manifest: stale } : {}) },
      output: [
        stale?.message,
        truncated ? `The result is cut at ${keep} of ${all.length} insights (size limit); \`insights\` holds those.` : undefined,
        insights.length ? lines.join("\n") : "No health insights.",
        insights.length > LISTED_LINES ? `…and ${insights.length - LISTED_LINES} more insights, all in the \`insights\` of the CLI's --json output.` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    }
  },
})
