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
export function runDbt(params: DbtRunParams): Promise<DbtRunResult> {
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

    execFile("dbt", args, { timeout: 300_000 }, (error, stdout, stderr) => {
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
