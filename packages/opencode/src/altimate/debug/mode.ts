// altimate_change start — debug mode: verbose, crash-tolerant tracing of what the agent is doing
/**
 * `ALTIMATE_DEBUG=1` turns this on. Each tool call is written to the log when it
 * starts and when it ends, and while any call is running a heartbeat line every
 * HEARTBEAT_MS names what is still running. The log is written as it happens, so
 * when the process stops (a hang the user kills, a crash) the last lines show
 * what it was doing — the one thing neither the log nor telemetry recorded before.
 * `altimate debug bundle` reads these lines back.
 */
import os from "os"
import { fileLog } from "@/altimate/util/file-log"
import { redact } from "./report"

export const HEARTBEAT_MS = 15_000

export function isDebugMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env["ALTIMATE_DEBUG"] ?? "")
}

/** One line per process start, always written: the log never recorded which version produced it. */
export function logStartup(version: string, extra: Record<string, unknown> = {}): void {
  const term = process.env["TERM_PROGRAM"] ?? (process.env["WT_SESSION"] ? "Windows Terminal" : process.env["TERM"]) ?? "unknown"
  fileLog("INFO", "debug", "altimate-code started", {
    version,
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    terminal: term,
    tty: Boolean(process.stdout.isTTY),
    debug: isDebugMode(),
    pid: process.pid,
    ...extra,
  })
}

interface Running {
  tool: string
  startedAt: number
}

const running = new Map<string, Running>()
let heartbeat: ReturnType<typeof setInterval> | undefined
/** Makes each traced call unique, so two parallel calls never share a key. */
let traceSeq = 0

function ensureHeartbeat(): void {
  if (heartbeat) return
  heartbeat = setInterval(() => {
    if (running.size === 0) return
    const now = Date.now()
    fileLog("INFO", "debug", "still running", {
      calls: [...running.entries()].map(([call, r]) => `${r.tool}#${call.slice(-8)}:${Math.round((now - r.startedAt) / 1000)}s`).join(","),
    })
  }, HEARTBEAT_MS)
  ;(heartbeat as { unref?: () => void }).unref?.()
}

/** Records a tool call starting. Returns the matching end; a no-op pair when debug mode is off. */
export function traceToolCall(tool: string, callID: string | undefined): (status: "success" | "error", detail?: string) => void {
  if (!isDebugMode()) return () => {}
  // Keyed per occurrence: a provider can repeat a call id, and a repeat must not overwrite or end the other call.
  const call = `${callID ?? tool}#${++traceSeq}`
  const startedAt = Date.now()
  running.set(call, { tool, startedAt })
  ensureHeartbeat()
  fileLog("INFO", "debug", "tool start", { tool, call })
  return (status, detail) => {
    running.delete(call)
    if (running.size === 0 && heartbeat) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }
    fileLog("INFO", "debug", "tool end", {
      tool,
      call,
      status,
      duration_ms: Date.now() - startedAt,
      // Tool errors can quote credentials, connection strings or paths: redacted before they are written.
      ...(detail ? { detail: redact(detail, logRedaction()).slice(0, 300) } : {}),
    })
  }
}

/** Each value gathered on its own, so one failing lookup does not drop the others. */
function logRedaction(): { home?: string; username?: string; hostname?: string } {
  const attempt = <T>(fn: () => T): T | undefined => {
    try {
      return fn()
    } catch {
      return undefined
    }
  }
  return {
    home: attempt(() => os.homedir()),
    username: attempt(() => os.userInfo().username) ?? process.env["USER"] ?? process.env["USERNAME"],
    hostname: attempt(() => os.hostname()),
  }
}

export function resetForTests(): void {
  running.clear()
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = undefined
}

export function runningForTests(): ReadonlyMap<string, Running> {
  return running
}
// altimate_change end
