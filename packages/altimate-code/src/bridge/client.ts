/**
 * Bridge client — JSON-RPC over stdio to the Python altimate-engine sidecar.
 *
 * Usage:
 *   const result = await Bridge.call("sql.execute", { sql: "SELECT 1" })
 *   Bridge.stop()
 */

import { spawn, type ChildProcess } from "child_process"
import { existsSync } from "fs"
import path from "path"
import type { BridgeMethod, BridgeMethods } from "./protocol"

export namespace Bridge {
  let child: ChildProcess | undefined
  let requestId = 0
  let restartCount = 0
  let starting: Promise<void> | null = null
  const MAX_RESTARTS = 2
  const CALL_TIMEOUT_MS = 30_000
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (reason: any) => void; timer: ReturnType<typeof setTimeout> }
  >()
  let buffer = ""

  export async function call<M extends BridgeMethod>(
    method: M,
    params: (typeof BridgeMethods)[M] extends { params: infer P } ? P : never,
  ): Promise<(typeof BridgeMethods)[M] extends { result: infer R } ? R : never> {
    if (!child || child.exitCode !== null) {
      if (restartCount >= MAX_RESTARTS) throw new Error("Python bridge failed after max restarts")
      await start()
    }
    const id = ++requestId
    const request = JSON.stringify({ jsonrpc: "2.0", method, params, id })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`Bridge timeout: ${method} (${CALL_TIMEOUT_MS}ms)`))
        }
      }, CALL_TIMEOUT_MS)

      pending.set(id, { resolve, reject, timer })
      child!.stdin!.write(request + "\n")
    })
  }

  function resolvePending(id: number, action: "resolve" | "reject", value: any) {
    const p = pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(id)
    p[action](value)
  }

  function rejectAllPending(error: Error) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(error)
      pending.delete(id)
    }
  }

  async function resolvePython(): Promise<string> {
    // 1. Explicit env var
    if (process.env.ALTIMATE_CLI_PYTHON) return process.env.ALTIMATE_CLI_PYTHON

    // 2. Check for .venv relative to altimate-engine package
    const engineDir = path.resolve(__dirname, "..", "..", "..", "altimate-engine")
    const venvPython = path.join(engineDir, ".venv", "bin", "python")
    if (existsSync(venvPython)) return venvPython

    // 3. Check for .venv in cwd
    const cwdVenv = path.join(process.cwd(), ".venv", "bin", "python")
    if (existsSync(cwdVenv)) return cwdVenv

    // 4. Production: uv-managed engine
    const { ensureEngine, enginePythonPath } = await import("./engine")
    try {
      await ensureEngine()
    } catch (err) {
      throw new Error(
        `Failed to bootstrap Python engine: ${err instanceof Error ? err.message : String(err)}. ` +
          `Set ALTIMATE_CLI_PYTHON to a Python 3.10+ interpreter to skip automatic bootstrap.`,
      )
    }
    return enginePythonPath()
  }

  async function start() {
    // Guard against re-entrant calls (start -> ping -> call -> start)
    if (starting) return starting
    starting = startImpl()
    try {
      await starting
    } finally {
      starting = null
    }
  }

  async function startImpl() {
    const pythonCmd = await resolvePython()
    child = spawn(pythonCmd, ["-m", "altimate_engine.server"], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    buffer = ""

    child.stdin!.on("error", () => {
      // Swallow stdin write errors — the exit/error handlers will reject pending calls
    })

    child.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const response = JSON.parse(line)
          if (response.error) {
            resolvePending(response.id, "reject", new Error(response.error.message))
          } else {
            resolvePending(response.id, "resolve", response.result)
          }
        } catch {
          // Skip non-JSON lines (Python startup messages, etc.)
        }
      }
    })

    child.stderr!.on("data", (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) console.error(`[altimate-engine] ${msg}`)
    })

    child.on("error", (err) => {
      rejectAllPending(new Error(`Failed to start Python engine: ${err.message}`))
      child = undefined
    })

    child.on("exit", (code) => {
      if (code !== 0) restartCount++
      rejectAllPending(new Error(`Bridge process exited (code ${code})`))
      child = undefined
    })

    // Verify the bridge is alive
    try {
      await call("ping", {} as any)
      restartCount = 0 // Reset on successful start
    } catch (e) {
      throw new Error(`Failed to start Python bridge: ${e}`)
    }
  }

  export function stop() {
    child?.kill()
    child = undefined
    restartCount = 0
  }

  export function isRunning(): boolean {
    return child !== undefined && child.exitCode === null
  }
}
