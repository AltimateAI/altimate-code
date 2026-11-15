import fs from "fs"
import path from "path"
import type { Tool } from "../../tool/tool"
import { projectRoot } from "../native/connections/registry"
import { sessionProject } from "./dbt-lineage"

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
 * The dbt adapter for a tool call, which every adapter-backed tool goes through. Starting the adapter
 * runs dbt deps and writes target/, and compiling renders Jinja, which can run SQL: a read-only call
 * (no write permission, or plan mode) never starts or uses it. Nor does a session in a dbt project the
 * adapter isn't set up for. The wait for the adapter to start is bounded and follows the call's abort.
 */
export async function dbtAdapterFor(ctx: Pick<Tool.Context, "abort" | "agent" | "extra">): Promise<DbtAdapterAccess> {
  const signal = ctx.abort
  if (ctx.extra?.forceReadOnly === true || ctx.agent === "plan")
    return {
      refusal: "read_only",
      reason: "this needs the dbt adapter, which a read-only call doesn't start: re-run with --allow-write",
    }
  try {
    const { getDbtAdapter, getDbtProjectRoot } = await import("../native/connections/register")
    // The import yields: a call cancelled meanwhile starts nothing.
    signal.throwIfAborted()
    const project = await sessionProject()
    signal.throwIfAborted()
    if (project?.other) {
      return {
        refusal: "other_project",
        reason: project.root
          ? `the dbt adapter is set up for ${project.root}, not ${project.other}`
          : `the dbt adapter isn't set up for ${project.other}`,
      }
    }
    let stop = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason)
      signal.addEventListener("abort", stop, { once: true })
      const seconds = dbtAdapterAccessInternals.adapterStartTimeoutMs / 1000
      timer = setTimeout(
        () => reject(new Error(`the dbt adapter didn't start within ${seconds} s`)),
        dbtAdapterAccessInternals.adapterStartTimeoutMs,
      )
    })
    const adapter = await Promise.race([getDbtAdapter(), waited]).finally(() => {
      signal.removeEventListener("abort", stop)
      clearTimeout(timer)
    })
    if (!adapter) {
      // No adapter also when the project exists but the adapter failed to start: say which.
      const root = await getDbtProjectRoot()
      const found = !!root && fs.existsSync(path.join(root, "dbt_project.yml"))
      return found
        ? { refusal: "not_started", reason: "the dbt adapter didn't start" }
        : { refusal: "no_project", reason: "no dbt project here" }
    }
    if (adapter.isInitialized?.() === false)
      return { refusal: "not_loaded", reason: "the dbt adapter didn't load the project" }
    return { adapter }
  } catch (e) {
    if (signal.aborted) throw e
    return { refusal: "not_started", reason: e instanceof Error ? e.message : String(e) }
  }
}
