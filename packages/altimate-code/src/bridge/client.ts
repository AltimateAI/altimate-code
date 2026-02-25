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
  const MAX_RESTARTS = 2
  const CALL_TIMEOUT_MS = 30_000
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void }>()
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
      pending.set(id, { resolve, reject })
      child!.stdin!.write(request + "\n")

      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`Bridge timeout: ${method} (${CALL_TIMEOUT_MS}ms)`))
        }
      }, CALL_TIMEOUT_MS)
    })
  }

  function resolvePython(): string {
    // 1. Explicit env var
    if (process.env.ALTIMATE_CLI_PYTHON) return process.env.ALTIMATE_CLI_PYTHON

    // 2. Check for .venv relative to altimate-engine package
    const engineDir = path.resolve(__dirname, "..", "..", "..", "altimate-engine")
    const venvPython = path.join(engineDir, ".venv", "bin", "python")
    if (existsSync(venvPython)) return venvPython

    // 3. Check for .venv in cwd
    const cwdVenv = path.join(process.cwd(), ".venv", "bin", "python")
    if (existsSync(cwdVenv)) return cwdVenv

    // 4. Fallback
    return "python3"
  }

  async function start() {
    const pythonCmd = resolvePython()
    child = spawn(pythonCmd, ["-m", "altimate_engine.server"], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    buffer = ""

    child.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const response = JSON.parse(line)
          const p = pending.get(response.id)
          if (p) {
            pending.delete(response.id)
            if (response.error) {
              p.reject(new Error(response.error.message))
            } else {
              p.resolve(response.result)
            }
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

    child.on("exit", (code) => {
      if (code !== 0) restartCount++
      for (const [id, p] of pending) {
        p.reject(new Error(`Bridge process exited (code ${code})`))
        pending.delete(id)
      }
      child = undefined
    })

    // Verify the bridge is alive
    try {
      await call("ping", {} as any)
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
