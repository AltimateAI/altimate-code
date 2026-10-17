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

// altimate_change start — dbt ls / dbt compile without a warehouse, for
// dbt-impact's compiled diff mode and job-map resolution.

/** Options shared by the offline helpers. Every artifact goes to `targetPath`
 *  / `logPath` (pass a temp dir), so the project's own `target/` is untouched. */
export interface DbtOfflineOptions {
  projectDir: string
  /** dbt executable (default `$ALTIMATE_DBT_BIN`, else `dbt` on PATH). */
  dbtBin?: string
  profilesDir?: string
  target?: string
  targetPath?: string
  logPath?: string
  timeoutMs?: number
}

export function dbtBinary(explicit?: string): string {
  return explicit || process.env.ALTIMATE_DBT_BIN || "dbt"
}

function commonArgs(o: DbtOfflineOptions): string[] {
  const a = ["--project-dir", o.projectDir]
  if (o.profilesDir) a.push("--profiles-dir", o.profilesDir)
  if (o.target) a.push("--target", o.target)
  if (o.targetPath) a.push("--target-path", o.targetPath)
  if (o.logPath) a.push("--log-path", o.logPath)
  return a
}

/** Run `dbt <args>` (no `+` rewriting, unlike {@link runDbt}). */
export function runDbtArgs(args: string[], o: Pick<DbtOfflineOptions, "dbtBin" | "timeoutMs" | "projectDir">): Promise<DbtRunResult> {
  return new Promise((resolve) => {
    execFile(
      dbtBinary(o.dbtBin),
      args,
      { cwd: o.projectDir, timeout: o.timeoutMs ?? 600_000, maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout: stdout || "", stderr: stderr || "", exit_code: 0 })
        const code = (error as any).code
        if (code === "ENOENT")
          return resolve({ stdout: "", stderr: `dbt CLI not found (${dbtBinary(o.dbtBin)})`, exit_code: 127 })
        resolve({
          stdout: stdout || "",
          stderr: error.killed ? "dbt command timed out" : stderr || error.message,
          exit_code: typeof code === "number" ? code : 1,
        })
      },
    )
  })
}

/** The models a selection resolves to, via `dbt ls` (parse only: no warehouse
 *  connection). Returns `unique_id`s. */
export async function dbtLs(
  sel: { select?: string; exclude?: string; selector?: string },
  o: DbtOfflineOptions,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const args = ["ls", "--resource-type", "model", "--output", "json", "--output-keys", "unique_id", "--quiet"]
  if (sel.selector) args.push("--selector", sel.selector)
  if (sel.select?.trim()) args.push("--select", ...sel.select.trim().split(/\s+/))
  if (sel.exclude?.trim()) args.push("--exclude", ...sel.exclude.trim().split(/\s+/))
  const r = await runDbtArgs([...args, ...commonArgs(o)], o)
  const ids = parseLsIds(r.stdout)
  if (r.exit_code !== 0) return { ok: false, error: lastLines(r.stderr || r.stdout) }
  return { ok: true, ids }
}

/** `unique_id`s from `dbt ls --output json` (one JSON object per line, mixed
 *  with log lines). */
export function parseLsIds(stdout: string): string[] {
  const ids: string[] = []
  for (const line of stdout.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("{")) continue
    try {
      const id = (JSON.parse(t) as { unique_id?: string }).unique_id
      if (id) ids.push(id)
    } catch {
      // a log line that happens to start with "{"
    }
  }
  return ids
}

/**
 * `dbt compile` without touching the warehouse when possible: first with
 * `--no-populate-cache --no-introspect` (works while the warehouse is down,
 * unless a model needs an introspective query), then a normal compile.
 * The manifest lands in `targetPath`.
 */
export async function dbtCompileOffline(
  select: string[],
  o: DbtOfflineOptions,
): Promise<{ ok: boolean; offline: boolean; error?: string }> {
  const base = ["compile", ...(select.length ? ["--select", ...select] : []), ...commonArgs(o)]
  const off = await runDbtArgs([...base, "--no-populate-cache", "--no-introspect"], o)
  if (off.exit_code === 0) return { ok: true, offline: true }
  const on = await runDbtArgs(base, o)
  if (on.exit_code === 0) return { ok: true, offline: false }
  return { ok: false, offline: false, error: lastLines(on.stdout + "\n" + on.stderr) }
}

function lastLines(s: string, n = 6): string {
  return s
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter((l) => l && !/^INFO:/.test(l))
    .slice(-n)
    .join(" | ")
}
// altimate_change end

// Exported for testing
export { ensureUpstreamSelector }
