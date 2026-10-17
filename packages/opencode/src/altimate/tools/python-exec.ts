/**
 * `python_exec` — run analyst Python against copies of scratch tables.
 *
 * Python never receives warehouse connections or credentials: inputs are scratch tables
 * exported to Parquet in a session-private working directory, and DataFrames saved by the
 * code are imported back into scratch. The child gets a minimal environment, a memory
 * limit, a deadline, and OS confinement (see `python-sandbox.ts`): reads are limited to the
 * session directory, the interpreter installation and required system files, writes to the
 * session directory, and network is blocked. Without an enforced mechanism the tool refuses.
 */
import z from "zod"
import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { Tool } from "../../tool/tool"
import { withScratchConnection } from "../native/connections/scratch"
import { quoteIdent } from "./sql-materialize"
import * as Sandbox from "./python-sandbox"

export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000
export const OUTPUT_LIMIT = 30_000
export const WORKSPACE_LIMIT_BYTES = 1024 ** 3
const MEMORY_LIMIT_BYTES = 8 * 1024 ** 3
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

const HELPER = `"""Scratch table exchange for python_exec."""
import os as _os
import re as _re
import duckdb as _duckdb

_HERE = _os.path.dirname(_os.path.abspath(__file__))
workspace = _os.getcwd()


def _name(name):
    if not isinstance(name, str) or not _re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", name):
        raise ValueError("Expected a scratch table name (letters, digits, underscores; no schema prefix)")
    return name


def load(name):
    """Return input table \`name\` (passed in \`inputs\`) as a pandas DataFrame."""
    with _duckdb.connect() as con:
        return con.execute("SELECT * FROM read_parquet(?)", [_os.path.join(_HERE, 'in', _name(name) + '.parquet')]).df()


def save(df, name):
    """Store a pandas DataFrame as scratch table \`name\` after a successful call (replacing it)."""
    file = _os.path.join(_HERE, 'out', _name(name) + '.parquet')
    with _duckdb.connect() as con:
        con.register("_frame", df)
        con.execute("COPY _frame TO ? (FORMAT parquet)", [file])
`

export const BOOTSTRAP = `import os, resource, runpy, sys, threading, time
def limit(kind):
    soft, hard = resource.getrlimit(kind)
    ceiling = ${MEMORY_LIMIT_BYTES}
    if hard != resource.RLIM_INFINITY:
        ceiling = min(ceiling, hard)
    if soft != resource.RLIM_INFINITY:
        ceiling = min(ceiling, soft)
    resource.setrlimit(kind, (ceiling, ceiling))
try:
    limit(resource.RLIMIT_AS)
except (ValueError, OSError):
    try:
        limit(resource.RLIMIT_DATA)
        print("Memory limit: data segment plus RSS watchdog (address-space limit unavailable).", file=sys.stderr)
    except (ValueError, OSError):
        print("Memory limit: cooperative RSS watchdog only (OS limits unavailable).", file=sys.stderr)
else:
    print("Memory limit: address space.", file=sys.stderr)

# Some macOS hosts reject setrlimit for both memory resources. Keep a best-effort
# watchdog there, and report the weaker protection instead of silently running unlimited.
# Native code holding the GIL can delay this check; it is not an OS security boundary.
def watch_memory():
    while True:
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        if sys.platform != "darwin":
            rss *= 1024
        if rss > ${MEMORY_LIMIT_BYTES}:
            os.write(2, b"Python memory limit exceeded; process killed.\\n")
            os._exit(137)
        time.sleep(0.1)

threading.Thread(target=watch_memory, daemon=True).start()
sys.path.insert(0, sys.argv[2])
sys.argv = [sys.argv[1]]
runpy.run_path(sys.argv[0], run_name="__main__")
`

let confinement: { python: string; result: Promise<Sandbox.Detection> } | undefined

/**
 * Detect and self-test the confinement mechanism once per interpreter and process. A refusal is
 * not cached, so a transient failure (a slow first import) does not disable the tool until restart.
 */
export function confinementFor(python: string): Promise<Sandbox.Detection> {
  if (confinement?.python === python) return confinement.result
  const result = Sandbox.detectConfinement({ python, bootstrap: BOOTSTRAP, env: childEnv })
    .catch(
      (error): Sandbox.Detection => ({
        ok: false,
        reason: `python_exec refused: confinement detection failed (${error instanceof Error ? error.message : String(error)}).`,
      }),
    )
    .then((detection) => {
      if (!detection.ok && confinement?.result === result) confinement = undefined
      return detection
    })
  confinement = { python, result }
  return result
}

/** Forget the cached detection (tests). */
export function resetConfinement() {
  confinement = undefined
}

let discovery: { key: string; result: Promise<string | undefined> } | undefined

/** Resolve version-manager shims, then verify dependencies with the actual child environment. */
export function interpreter(): Promise<string | undefined> {
  const name = process.env.ALTIMATE_PYTHON?.trim() || "python3"
  const key = JSON.stringify([name, process.env.PATH, process.env.PYENV_ROOT])
  if (discovery?.key === key) return discovery.result
  const result = (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "altimate-python-probe-"))
    try {
      // Only locating Python uses the host HOME/PATH, so pyenv/asdf shims can resolve.
      // Never inherit credentials, and never run analyst code in this probe.
      const resolve = await Sandbox.execute(
        [Bun.which(name) ?? name, "-I", "-c", "import sys; print(sys.executable)"],
        {
          env: {
            ...childEnv(directory),
            HOME: os.homedir(),
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            ...(process.env.PYENV_ROOT ? { PYENV_ROOT: process.env.PYENV_ROOT } : {}),
          },
          timeout: 5000,
        },
      )
      const executable = resolve.status === 0 ? resolve.stdout.trim() : ""
      if (!executable || !path.isAbsolute(executable)) return
      const probe = await Sandbox.execute([executable, "-I", "-c", "import pandas, duckdb"], {
        cwd: directory,
        env: childEnv(directory),
        timeout: 10000,
      })
      return probe.status === 0 ? executable : undefined
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })().catch(() => undefined)
  discovery = { key, result }
  return result
}

export async function pythonExecAvailable(): Promise<boolean> {
  return process.env.ALTIMATE_PYTHON_EXEC !== "0" && (await interpreter()) !== undefined
}

/** Minimal child environment: no credentials, tokens or connection strings from the parent. */
export function childEnv(workdir: string): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: workdir,
    TMPDIR: path.join(workdir, "tmp"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    MPLBACKEND: "Agg",
    OMP_NUM_THREADS: "2",
    OPENBLAS_NUM_THREADS: "2",
  }
}

export function clip(text: string, limit = OUTPUT_LIMIT): { text: string; clipped: boolean } {
  if (text.length <= limit) return { text, clipped: false }
  const head = Math.floor(limit * 0.6)
  const tail = limit - head
  return {
    text: `${text.slice(0, head)}\n... [${text.length - limit} characters omitted] ...\n${text.slice(-tail)}`,
    clipped: true,
  }
}

export function clampTimeout(ms: number | undefined): number {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(1000, Math.floor(ms)), MAX_TIMEOUT_MS)
}

/** Logical sizes also count sparse files; never traverse links outside the private directory. */
async function workspaceSize(directory: string): Promise<number> {
  let bytes = 0
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [] // A running cell may remove a temporary directory.
    throw error
  })
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    const stat = await fs.lstat(file).catch((error) => {
      if (error.code === "ENOENT") return undefined // A running cell may remove files.
      throw error
    })
    if (!stat) continue
    if (stat.isSymbolicLink()) throw new Error("Python workspace cannot contain symbolic links.")
    if (stat.isDirectory()) bytes += await workspaceSize(file)
    else bytes += stat.size
    if (bytes > WORKSPACE_LIMIT_BYTES)
      throw new Error(`Python workspace size cap exceeded (${WORKSPACE_LIMIT_BYTES} bytes).`)
  }
  return bytes
}

/** How long output may keep draining after the sandbox is killed before the pipes are closed. */
const PIPE_GRACE_MS = 300

type RunResult = {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  workspaceError?: string
}

function run(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  abort: AbortSignal,
  privateDirectory: string,
) {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let workspaceError: string | undefined
    const cap = OUTPUT_LIMIT * 20
    child.stdout.on("data", (d) => {
      if (stdout.length < cap) stdout += d.toString().slice(0, cap - stdout.length)
    })
    child.stderr.on("data", (d) => {
      if (stderr.length < cap) stderr += d.toString().slice(0, cap - stderr.length)
    })
    let exitCode: number | null = null
    let exitSignal: string | null = null
    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    // Descendants seen so far (pid -> start time). A child that calls setsid leaves the process
    // group, and once its parent exits it is re-parented, so the tree must be recorded while alive.
    const known = new Map<number, string>()
    const snapshot = () => {
      const ps = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 2000 })
      const table = new Map<number, { parent: number; started: string }>()
      for (const line of (ps.stdout ?? "").split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line)
        if (m) table.set(Number(m[1]), { parent: Number(m[2]), started: m[3] })
      }
      return table
    }
    const track = () => {
      if (!child.pid) return
      const table = snapshot()
      const tree = new Set<number>([...known.keys(), child.pid])
      for (let grew = true; grew; ) {
        grew = false
        for (const [pid, entry] of table)
          if (!tree.has(pid) && tree.has(entry.parent)) {
            tree.add(pid)
            known.set(pid, entry.started)
            grew = true
          }
      }
    }
    const tracker = setInterval(track, 100)
    // Kill the whole sandbox, not only the process group: the group, then every recorded
    // descendant whose start time still matches (so a reused pid is never signalled). On Linux the
    // bwrap PID namespace (--die-with-parent) also ends everything when bwrap dies.
    const kill = () => {
      try {
        track()
        const table = snapshot()
        for (const [pid, started] of known) if (table.get(pid)?.started === started) process.kill(pid, "SIGKILL")
      } catch {}
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
      // A descendant may still hold the pipes open; stop waiting for them shortly after the kill.
      grace ??= setTimeout(finish, PIPE_GRACE_MS)
    }
    const finish = async () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      clearInterval(monitor)
      clearInterval(tracker)
      abort.removeEventListener("abort", onAbort)
      child.stdout.destroy()
      child.stderr.destroy()
      await checking
      resolve({ code: exitCode, signal: exitSignal, stdout, stderr, timedOut, workspaceError })
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    const onAbort = () => kill()
    abort.addEventListener("abort", onAbort, { once: true })
    if (abort.aborted) kill()
    // Check the whole Python directory, including temporary exports and output, so
    // repeated calls cannot bypass the workspace budget through HOME or TMPDIR.
    let checking: Promise<void> | undefined
    const monitor = setInterval(() => {
      if (checking) return
      checking = workspaceSize(privateDirectory)
        .then(
          () => {},
          (error) => {
            workspaceError = error instanceof Error ? error.message : String(error)
            kill()
          },
        )
        .finally(() => {
          checking = undefined
        })
    }, 100)
    child.on("error", (e) => {
      stderr += `\n${e.message}`
    })
    // A cell may spawn children and exit without waiting. They must not outlive it, and one that
    // keeps stdout/stderr open must not keep the call from returning.
    child.on("exit", (code, signal) => {
      exitCode = code
      exitSignal = signal
      kill()
    })
    child.on("close", () => void finish())
  })
}

export const PythonExecTool = Tool.define("python_exec", {
  description:
    "Run Python for non-SQL computation over scratch data; no warehouse connections or inherited credentials. " +
    "Runs in an OS sandbox: it can read only its working directory and the Python installation, write only its working directory, " +
    "and has no network; the result reports the confinement used. It refuses to run where the host cannot enforce this. " +
    "Materialize source data to scratch first. " +
    "List scratch tables in inputs, then `from altimate_io import load, save, workspace`: " +
    "`load('table')` returns a pandas DataFrame; `save(df, 'name')` replaces that scratch table after a successful call. " +
    "The working directory (also `workspace`) is a size-capped, session-private path: files persist across calls " +
    "and are deleted with the session; exceeding the cap clears the workspace. " +
    "Each call starts a fresh process with pandas and duckdb available. " +
    "Print results to see them; long output is clipped. Omit timeout_ms to use the configured default.",
  parameters: z.object({
    code: z.string().describe("Python source to run"),
    inputs: z.array(z.string()).optional().describe("Scratch tables available to load(); omit for none"),
    timeout_ms: z.number().optional().describe("Deadline for this call; omit to use the configured default"),
  }),
  async execute(args, ctx) {
    const failure = (message: string) => ({ title: "Python: ERROR", metadata: { ok: false }, output: message })
    if (ctx.agent !== "analyst") return failure("python_exec is available only to the analyst agent.")
    if (process.env.ALTIMATE_PYTHON_EXEC === "0") return failure("python_exec is disabled by ALTIMATE_PYTHON_EXEC=0.")
    const inputs = [...new Set((args.inputs ?? []).map((s) => s.trim()).filter(Boolean))]
    const bad = inputs.find((t) => !IDENTIFIER.test(t))
    if (bad)
      return failure(`Input "${bad}" is not a scratch table name (letters, digits, underscores; no schema prefix).`)
    if (!args.code.trim()) return failure("No code to run.")
    if (ctx.abort.aborted) return failure("Python call aborted before execution.")
    await ctx.ask({ permission: "python_exec", patterns: ["*"], always: ["*"], metadata: {} })
    const python = await interpreter()
    if (!python) return failure("python_exec unavailable: no Python with pandas and duckdb was discovered.")
    const detected = await confinementFor(python)
    if (!detected.ok) return failure(detected.reason)
    const sandbox = detected.confinement
    const timeoutMs = clampTimeout(args.timeout_ms)
    try {
      // Hold the session's scratch lock through execution and import. Concurrent cells
      // (including subagent calls sharing a root) cannot race the persistent workspace.
      return await withScratchConnection(async (scratch, directory) => {
        if (ctx.abort.aborted) return failure("Python call aborted before execution.")
        const privateDirectory = path.join(directory, "python")
        const workspace = path.join(privateDirectory, "workspace")
        await fs.mkdir(workspace, { recursive: true, mode: 0o700 })
        const resetWorkspace = async () => {
          await fs.rm(privateDirectory, { recursive: true, force: true })
          await fs.mkdir(workspace, { recursive: true, mode: 0o700 })
        }
        try {
          await workspaceSize(privateDirectory)
        } catch (error) {
          await resetWorkspace()
          return failure(`${error instanceof Error ? error.message : String(error)} Workspace cleared; retry the call.`)
        }
        const callDirectory = await fs.mkdtemp(path.join(privateDirectory, "call-"))
        try {
          for (const name of ["in", "out", "tmp"]) await fs.mkdir(path.join(callDirectory, name))
          await fs.writeFile(path.join(callDirectory, "altimate_io.py"), HELPER)
          await fs.writeFile(path.join(callDirectory, "_bootstrap.py"), BOOTSTRAP)
          const cell = path.join(callDirectory, "cell.py")
          await fs.writeFile(cell, args.code)
          for (const table of inputs) {
            const file = path.join(callDirectory, "in", `${table}.parquet`).replaceAll("'", "''")
            await scratch.execute(
              `COPY (SELECT * FROM ${quoteIdent(table)}) TO '${file}' (FORMAT parquet)`,
              undefined,
              undefined,
              { noLimit: true },
            )
          }
          try {
            await workspaceSize(privateDirectory)
          } catch (error) {
            await resetWorkspace()
            return failure(
              `${error instanceof Error ? error.message : String(error)} Workspace cleared; reduce the inputs and retry.`,
            )
          }
          const started = Date.now()
          const result = await run(
            Sandbox.launch({
              confinement: sandbox,
              write: [await fs.realpath(privateDirectory)],
              cwd: workspace,
              python,
              args: [path.join(callDirectory, "_bootstrap.py"), cell, callDirectory],
            }),
            workspace,
            { ...childEnv(workspace), TMPDIR: path.join(callDirectory, "tmp") },
            timeoutMs,
            ctx.abort,
            privateDirectory,
          )
          const elapsed = Date.now() - started
          try {
            await workspaceSize(privateDirectory)
          } catch (error) {
            result.workspaceError ??= error instanceof Error ? error.message : String(error)
          }
          if (result.workspaceError) await resetWorkspace()

          const imported: string[] = []
          const importErrors: string[] = []
          // Only publish complete, successful calls; never import partial files after a kill.
          if (result.code === 0 && !result.timedOut && !ctx.abort.aborted && !result.workspaceError) {
            const outDir = path.join(callDirectory, "out")
            const files = await fs.readdir(outDir, { withFileTypes: true })
            for (const file of files) {
              if (!file.isFile() || !file.name.endsWith(".parquet") || !IDENTIFIER.test(file.name.slice(0, -8)))
                continue
              const name = file.name.slice(0, -8)
              const location = path.join(outDir, file.name).replaceAll("'", "''")
              try {
                await scratch.execute(
                  `CREATE OR REPLACE TABLE ${quoteIdent(name)} AS SELECT * FROM read_parquet('${location}')`,
                  undefined,
                  undefined,
                  { noLimit: true },
                )
                const n = (await scratch.execute(`SELECT count(*) FROM ${quoteIdent(name)}`, 1)).rows[0]?.[0]
                imported.push(`scratch.${name} (${n} rows)`)
              } catch (error) {
                importErrors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          }
          const ok =
            result.code === 0 &&
            !result.timedOut &&
            !ctx.abort.aborted &&
            !result.workspaceError &&
            !importErrors.length
          const status = result.timedOut
            ? `timed out after ${Math.round(timeoutMs / 1000)} s (process killed)`
            : ctx.abort.aborted
              ? "aborted (process killed)"
              : ok
                ? `exit 0 in ${(elapsed / 1000).toFixed(1)} s`
                : `failed (exit ${result.code ?? result.signal})`
          const stdout = clip(result.stdout)
          const stderr = clip(result.stderr, OUTPUT_LIMIT / 3)
          const parts = [
            `Python ${status}.`,
            `Isolation: filesystem ${sandbox.filesystem} (reads limited to the workspace and Python installation; writes to the workspace); network ${sandbox.network}; minimal environment.`,
            `Workspace: ${workspace}`,
          ]
          if (result.workspaceError) parts.push(`${result.workspaceError} Workspace cleared; retry with smaller files.`)
          if (imported.length) parts.push(`Saved to scratch: ${imported.join(", ")}.`)
          if (importErrors.length) parts.push(`Could not import: ${importErrors.join("; ")}`)
          if (stdout.text) parts.push(`stdout:\n${stdout.text}`)
          if (stderr.text) parts.push(`stderr:\n${stderr.text}`)
          if (!stdout.text && !stderr.text) parts.push("(no output; print the values you need)")
          return {
            title: `Python: ${ok ? "ok" : "failed"}${imported.length ? `, ${imported.length} table(s) saved` : ""}`,
            metadata: {
              ok,
              exitCode: result.code,
              timedOut: result.timedOut,
              elapsedMs: elapsed,
              filesystem: sandbox.filesystem,
              network: sandbox.network,
              workspace,
              workspaceError: result.workspaceError,
              imported,
            },
            output: parts.join("\n\n"),
          }
        } finally {
          await fs.rm(callDirectory, { recursive: true, force: true })
        }
      }, ctx.sessionID)
    } catch (error) {
      return failure(`Python execution failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
})
