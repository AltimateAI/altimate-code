// altimate_change start — validate offline dbt targets before spawning dbt
import { Offline } from "@/config/offline"
import { assertLocalDbt } from "./offline"
import { LIBPQ_DESTINATION_VARS } from "../../../../../dbt-tools/src/offline-env"
// altimate_change end
/**
 * dbt CLI wrapper — spawn dbt commands as subprocesses.
 *
 * Ported from Python altimate_engine.dbt.runner.
 */

import { execFile } from "child_process"
import type {
  DbtRunParams,
  DbtRunResult,
} from "../types"

/**
 * Prepend + to selector for build/run/test to include upstream deps.
 */
function ensureUpstreamSelector(select: string, command: string): string {
  if (!["build", "run", "test"].includes(command)) return select
  if (select.startsWith("+")) return select
  // Tag/path/source selectors: don't add +
  if (select.includes(":") && !select.startsWith("+")) return select
  return `+${select}`
}

/**
 * Run a dbt CLI command via subprocess.
 */
export async function runDbt(params: DbtRunParams): Promise<DbtRunResult> {
  // Offline: dbt runs with the exact profiles directory checked here and without its
  // usage-stats and PyPI version-check requests.
  let offlineEnv: NodeJS.ProcessEnv | undefined
  if (Offline.enabled()) {
    try {
      const command = params.command || "run"
      if (command === "deps") throw new Error("Offline mode disables dbt dependency installation.")
      if ((params.args ?? []).some((arg) => arg === "--send-anonymous-usage-stats" || arg.startsWith("--send-anonymous-usage-stats=")))
        throw new Error("Offline mode disables dbt usage reporting.")
      // dbt's version flags look up the latest release on PyPI whatever DBT_VERSION_CHECK says.
      if ((params.args ?? []).some((arg) => ["--version", "-V", "-v"].includes(arg)))
        throw new Error("Offline mode disables dbt version reporting.")
      // `dbt init` creates a project and `dbt clean` deletes local folders; neither opens a connection.
      const checked = command === "init" || command === "clean"
        ? undefined
        : await assertLocalDbt(params.project_dir || process.cwd(), [
            ...(params.args ?? []),
            ...(params.project_dir ? ["--project-dir", params.project_dir] : []),
          ])
      const inherited = { ...process.env }
      // Environment names are case-insensitive on Windows.
      for (const key of Object.keys(inherited))
        if ((LIBPQ_DESTINATION_VARS as readonly string[]).includes(key.toUpperCase())) delete inherited[key]
      offlineEnv = {
        ...inherited,
        ...(checked ? { DBT_PROFILES_DIR: checked.profilesDir } : {}),
        DBT_SEND_ANONYMOUS_USAGE_STATS: "false",
        DO_NOT_TRACK: "1",
        DBT_VERSION_CHECK: "false",
      }
    } catch (error) {
      return { stdout: "", stderr: String(error), exit_code: 1 }
    }
  }
  return new Promise((resolve) => {
    const command = params.command || "run"
    const args: string[] = [command]

    if (params.select) {
      const select = ensureUpstreamSelector(params.select, command)
      args.push("--select", select)
    }

    if (params.args) {
      args.push(...params.args)
    }

    if (params.project_dir) {
      args.push("--project-dir", params.project_dir)
    }

    execFile("dbt", args, { timeout: 300_000, env: offlineEnv ?? process.env }, (error, stdout, stderr) => {
      if (error) {
        if ((error as any).code === "ENOENT") {
          resolve({
            stdout: "",
            stderr: "dbt CLI not found. Install with: pip install dbt-core",
            exit_code: 127,
          })
          return
        }
        if (error.killed) {
          resolve({
            stdout: stdout || "",
            stderr: "dbt command timed out after 300 seconds",
            exit_code: 124,
          })
          return
        }
        resolve({
          stdout: stdout || "",
          stderr: stderr || error.message,
          exit_code: (error as any).code ?? 1,
        })
        return
      }
      resolve({
        stdout: stdout || "",
        stderr: stderr || "",
        exit_code: 0,
      })
    })
  })
}

// Exported for testing
export { ensureUpstreamSelector }
