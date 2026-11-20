import fs from "fs"
import path from "path"
import type { Tool } from "../../tool/tool"
import { projectRoot } from "../native/connections/registry"

/** Why a tool may not use the dbt adapter. */
export type DbtAdapterRefusal = "read_only" | "other_project" | "no_project" | "not_started" | "not_loaded"

/** The project's dbt adapter, or why this call may not use it (`reason` is a sentence for the user). */
export type DbtAdapterAccess =
  | { adapter: any; refusal?: undefined; reason?: undefined }
  | { adapter?: undefined; refusal: DbtAdapterRefusal; reason: string }

/** Test seams. */
export const dbtAdapterAccessInternals = {
  /** How long a call waits for the dbt adapter to start before it gives up; the start goes on for the next call. */
  adapterStartTimeoutMs: 120_000,
}

/**
 * The dbt adapter for a tool call, which the adapter-backed tools added after dbt_lineage go through.
 * Starting the adapter runs dbt deps and writes target/, and compiling renders Jinja, which can run
 * SQL: a read-only call (no write permission, or plan mode) never starts or uses it. Nor does a
 * session in a dbt project the adapter isn't set up for. Every wait, the project lookup and the
 * adapter's start, is bounded by one deadline and follows the call's abort.
 */
export async function dbtAdapterFor(ctx: Pick<Tool.Context, "abort" | "agent" | "extra">): Promise<DbtAdapterAccess> {
  const signal = ctx.abort
  // A cancelled call answers nothing, refused or not.
  signal.throwIfAborted()
  if (ctx.extra?.forceReadOnly === true || ctx.agent === "plan")
    return {
      refusal: "read_only",
      reason: "this needs the dbt adapter, which a read-only call doesn't start: re-run with --allow-write",
    }
  // One deadline and the call's abort bound every wait below, the dbt config reads included: a stalled
  // read gives up with the start's timeout, and a cancelled call stops waiting at once.
  let stop = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason)
    signal.addEventListener("abort", stop, { once: true })
    const seconds = dbtAdapterAccessInternals.adapterStartTimeoutMs / 1000
    timer = setTimeout(
      () => reject(new Error(`the dbt adapter wasn't ready within ${seconds} s`)),
      dbtAdapterAccessInternals.adapterStartTimeoutMs,
    )
  })
  // It can reject between two races, when nothing awaits it: the next race still sees the rejection.
  waited.catch(() => {})
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    const value = await Promise.race([work, waited])
    // An abort queued while the work settled still wins.
    signal.throwIfAborted()
    return value
  }
  try {
    const { getDbtAdapter, getDbtProjectRoot, getDbtPythonPath } = await bounded(import("../native/connections/register"))
    const project = await bounded(sessionProject())
    if (project?.other) {
      return {
        refusal: "other_project",
        reason: project.root
          ? `the dbt adapter is set up for ${project.root}, not ${project.other}`
          : `the dbt adapter isn't set up for ${project.other}`,
      }
    }
    const adapter = await bounded(getDbtAdapter())
    if (!adapter) {
      // No adapter also when the project exists but the adapter failed to start: say which.
      const root = await bounded(getDbtProjectRoot())
      const found = !!root && fs.existsSync(path.join(root, "dbt_project.yml"))
      return found
        ? { refusal: "not_started", reason: `the dbt adapter didn't start${pythonHint(getDbtPythonPath(), await bounded(savedDbtConfig()))}` }
        : { refusal: "no_project", reason: "no dbt project here" }
    }
    if (project?.root) {
      // The adapter starts from its own read of the config, which can differ from the one checked above.
      const published = await bounded(getDbtProjectRoot())
      if (!published || path.relative(real(published), real(project.root)))
        return {
          refusal: "other_project",
          reason: `the dbt adapter is set up for ${published ?? "no project"}, not ${project.root}`,
        }
    }
    if (adapter.isInitialized?.() === false)
      return { refusal: "not_loaded", reason: `the dbt adapter didn't load the project${pythonHint(getDbtPythonPath(), await bounded(savedDbtConfig()))}` }
    return { adapter }
  } catch (e) {
    if (signal.aborted) throw e
    return { refusal: "not_started", reason: e instanceof Error ? e.message : String(e) }
  } finally {
    signal.removeEventListener("abort", stop)
    clearTimeout(timer)
  }
}

/**
 * How to fix an adapter that didn't start or load, which is most often dbt missing from the Python it was
 * started with. A pythonPath saved in ~/.altimate-code/dbt.json wins over any virtualenv, so that is what
 * to change then. The adapter is kept for the life of the process, so the fix takes effect in a new one.
 */
function pythonHint(python: string | undefined, saved: boolean): string {
  const which = python ? ` (${python})` : ""
  const restart = "then start a new session, or run `altimate-code tool daemon stop` for the `tool run` daemon"
  return saved
    ? `: dbt runs with the Python that ~/.altimate-code/dbt.json names${which}, which may not be the project's. Set pythonPath there to a Python that has dbt installed, ${restart}`
    : `: dbt runs with the Python found when the tools started${which}, which may not be the project's. Activate the project's virtualenv (or set pythonPath in ~/.altimate-code/dbt.json), ${restart}`
}

/**
 * Whether ~/.altimate-code/dbt.json picks the Python: it parses and names a pythonPath. A file without one,
 * or one that doesn't parse, leaves the choice to discovery (project venv, VIRTUAL_ENV, CONDA_PREFIX, PATH).
 */
async function savedDbtConfig(): Promise<boolean> {
  try {
    const { path: configPath } = await import("../../../../dbt-tools/src/config")
    const saved = JSON.parse(await fs.promises.readFile(configPath(), "utf8")) as { pythonPath?: unknown } | null
    return typeof saved?.pythonPath === "string" && saved.pythonPath.trim() !== ""
  } catch {
    return false
  }
}

/** `p` with its links resolved, or as given when it can't be. */
function real(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * The adapter's project root and, when the session's directory is in another dbt project, that one
 * (`other`, both links resolved). Undefined when the session's directory is in no dbt project: the
 * adapter's own discovery (a dbt.json, or a walk up from the working directory) decides then.
 */
async function sessionProject(): Promise<{ root?: string; other?: string } | undefined> {
  const { findProjectRoot } = await import("../../../../dbt-tools/src/config")
  const found = findProjectRoot(projectRoot())
  if (!found) return undefined
  const { getDbtProjectRoot } = await import("../native/connections/register")
  const root = await getDbtProjectRoot()
  const here = real(found)
  // path.relative ignores case on win32.
  if (!root) return { other: here }
  return path.relative(real(root), here) ? { root: real(root), other: here } : { root }
}
