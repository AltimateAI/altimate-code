import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdirSync, realpathSync, rmSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Global } from "@/global"
import type { Runner, ToolResult } from "./runner"

export const DEFAULT_IDLE_MS = 600_000
export const SPAWN_WAIT_MS = 3_000
const POLL_MS = 50
// sockaddr_un limits: 104 bytes on macOS, 108 on Linux.
const MAX_SOCKET_PATH = 100

export interface Request {
  id: string
  op?: "run" | "status" | "stop"
  name?: string
  args?: unknown
  allowWrite?: boolean
}

export type Response = ToolResult & { id: string }

export interface DaemonInfo {
  pid: number
  directory: string
  version: string
  startedAt: number
  idleMs: number
  requests: number
}

export function resolveDirectory(directory: string): string {
  try {
    return realpathSync(path.resolve(directory))
  } catch {
    return path.resolve(directory)
  }
}

/**
 * Identifies one daemon: the project directory, the explicit connections file if any, and the CLI version, so an
 * upgrade never reuses an old process and a daemon never serves connections it was not started with.
 */
export function socketName(directory: string, version: string, connections?: string, workspaceTools?: boolean): string {
  const parts = [resolveDirectory(directory), ...(connections ? [path.resolve(connections)] : [])]
  // Appended only when set, so existing daemons keep their names.
  if (workspaceTools) parts.push("workspace-tools")
  const key = parts.join("\0")
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12)
  return `tool-${hash}-${version.replace(/[^A-Za-z0-9.-]/g, "_")}`
}

/** A named pipe on Windows, otherwise a socket file under the global state path (or the temp dir when that path is too long). */
export function socketPath(directory: string, version: string, base?: string, connections?: string, workspaceTools?: boolean): string {
  const name = socketName(directory, version, connections, workspaceTools)
  if (process.platform === "win32") return `\\\\.\\pipe\\altimate-code-${name}`
  const preferred = path.join(base ?? path.join(Global.Path.state, "tool-daemon"), `${name}.sock`)
  if (base !== undefined || Buffer.byteLength(preferred) <= MAX_SOCKET_PATH) return preferred
  return path.join(os.tmpdir(), `altimate-code-${os.userInfo().uid}`, `${name}.sock`)
}

export function idleMs(): number {
  const value = Number(process.env.ALTIMATE_TOOL_DAEMON_IDLE_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_IDLE_MS
}

export function daemonDisabled(): boolean {
  return process.env.ALTIMATE_TOOL_DAEMON === "0"
}

/** Connects to a socket; resolves undefined when nothing is listening (missing or stale socket). */
export function connect(file: string): Promise<net.Socket | undefined> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(file)
    socket.once("connect", () => {
      socket.removeAllListeners("error")
      resolve(socket)
    })
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") return resolve(undefined)
      reject(error)
    })
  })
}

function removeSocket(file: string) {
  if (process.platform !== "win32") rmSync(file, { force: true })
}

/** Reads newline-delimited JSON messages from a socket. */
function lines(socket: net.Socket, onLine: (line: string) => void) {
  let buffer = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf("\n")
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim()) onLine(line)
      index = buffer.indexOf("\n")
    }
  })
}

function exchange(socket: net.Socket, request: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    lines(socket, (line) => {
      try {
        resolve(JSON.parse(line) as Response)
      } catch (error) {
        reject(error)
      }
      socket.end()
    })
    socket.once("error", reject)
    socket.once("close", () => reject(new Error("The tool daemon closed the connection before replying.")))
    socket.write(JSON.stringify(request) + "\n")
  })
}

/** Sends one request. Resolves undefined when no daemon is listening; a stale socket file is removed. */
export async function send(file: string, request: Request, cleanStale = true): Promise<Response | undefined> {
  const socket = await connect(file)
  if (!socket) {
    if (cleanStale) removeSocket(file)
    return undefined
  }
  return exchange(socket, request)
}

export interface DaemonOptions {
  directory: string
  version: string
  runner: Runner
  file?: string
  idleMs?: number
  /** Closes embedded file-database connections between requests so their file locks are released. */
  releaseFiles?: () => Promise<void>
}

export interface Daemon {
  file: string
  closed: Promise<void>
  stop(): Promise<void>
}

/** Serves tool requests on the daemon socket until stopped or idle. Throws when another daemon already owns the socket. */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const directory = resolveDirectory(options.directory)
  const file = options.file ?? socketPath(directory, options.version)
  const idle = options.idleMs ?? idleMs()
  const startedAt = Date.now()
  let requests = 0
  let inflight = 0
  let stopping: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const sockets = new Set<net.Socket>()
  let finish!: () => void
  const closed = new Promise<void>((resolve) => (finish = resolve))

  const info = (): DaemonInfo => ({ pid: process.pid, directory, version: options.version, startedAt, idleMs: idle, requests })

  const handle = async (request: Request): Promise<Response> => {
    if (request.op === "status") return { id: request.id, status: "ok", title: "Tool daemon", output: "running", metadata: { ...info() } }
    if (request.op === "stop") {
      setImmediate(() => void stop())
      return { id: request.id, status: "ok", title: "Tool daemon", output: "stopping", metadata: {} }
    }
    requests++
    if (typeof request.name !== "string")
      return { id: request.id, status: "error", title: "Invalid request", output: "A tool name is required.", metadata: {} }
    const result = await options.runner.run(request.name, request.args ?? {}, { allowWrite: request.allowWrite === true })
    // Release DuckDB/SQLite file locks between calls so `dbt build` and other clients can open the file.
    if (inflight <= 1) await options.releaseFiles?.().catch(() => {})
    return { id: request.id, ...result }
  }

  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (inflight > 0) return arm()
      void stop()
    }, idle)
  }

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    lines(socket, (line) => {
      inflight++
      arm()
      Promise.resolve()
        .then(() => handle(JSON.parse(line) as Request))
        .catch((error): Response => ({
          id: "",
          status: "error",
          title: "Invalid request",
          output: error instanceof Error ? error.message : String(error),
          metadata: {},
        }))
        .then((response) => {
          if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n")
        })
        .finally(() => {
          inflight--
          arm()
        })
    })
  })

  function stop(): Promise<void> {
    stopping ??= (async () => {
      clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      removeSocket(file)
      try {
        await options.runner.close()
      } finally {
        finish()
      }
    })()
    return stopping
  }

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(file, () => {
        server.removeListener("error", reject)
        resolve()
      })
    })

  if (process.platform !== "win32") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    await listen()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
    const live = await connect(file)
    if (live) {
      live.destroy()
      throw new Error(`A tool daemon is already running for ${directory}.`)
    }
    removeSocket(file)
    await listen()
  }
  arm()
  return { file, closed, stop }
}

/** The argv that starts this same program again: a compiled binary runs by itself, a script run needs its runtime and entry file. */
export function selfCommand(): string[] {
  const script = process.argv[1]
  const compiled = !script || script.startsWith("/$bunfs/") || script.includes("~BUN")
  return compiled ? [process.execPath] : [process.execPath, ...process.execArgv, script]
}

function spawnDaemon(directory: string, connections?: string, workspaceTools?: boolean) {
  const [command, ...rest] = selfCommand()
  const extra = [...(connections ? ["--connections", path.resolve(connections)] : []), ...(workspaceTools === undefined ? [] : [workspaceTools ? "--workspace-tools" : "--no-workspace-tools"])]
  const child = spawn(command, [...rest, "tool", "daemon", "--dir", directory, ...extra], {
    cwd: directory,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.on("error", () => {})
  child.unref()
}

/**
 * Sends a request to the daemon for this directory and version, starting one when none is listening.
 * Resolves undefined when no daemon could be reached within the wait, so the caller can run in-process.
 */
export async function runViaDaemon(
  directory: string,
  version: string,
  request: Request,
  options: { file?: string; spawn?: (directory: string) => void; waitMs?: number; connections?: string; workspaceTools?: boolean } = {},
): Promise<Response | undefined> {
  const file = options.file ?? socketPath(directory, version, undefined, options.connections, options.workspaceTools)
  const first = await send(file, request)
  if (first) return first
  if (options.spawn) options.spawn(resolveDirectory(directory))
  else spawnDaemon(resolveDirectory(directory), options.connections, options.workspaceTools)
  const deadline = Date.now() + (options.waitMs ?? SPAWN_WAIT_MS)
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    const reply = await send(file, request, false)
    if (reply) return reply
  }
  return undefined
}
