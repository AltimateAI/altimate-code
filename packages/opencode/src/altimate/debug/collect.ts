// altimate_change start — debug report: gathers the facts `report.ts` analyses
/**
 * Every probe here is read-only and independently guarded: a failing probe is
 * recorded in the report, it never stops the report. Values that could carry
 * secrets (connection fields, proxy credentials, env values) are reduced to
 * names or hosts before they leave this file.
 */
import fs from "fs"
import os from "os"
import path from "path"
import dns from "dns/promises"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { resolveInstall } from "@/installation"
import { Telemetry } from "@/altimate/telemetry"
import { AltimateApi } from "@/altimate/api/client"
import * as Registry from "@/altimate/native/connections/registry"
import { resolveConfig } from "@/altimate/native/connections/credential-store"
import { isDebugMode } from "./mode"
import { analyzeLog, needsPassword, parseLog, redact, type ConnectionFact, type Facts, type NetworkCheck, type RedactContext } from "./report"

/** Last part of the log read; enough for weeks of normal use without loading a huge file. */
const LOG_READ_BYTES = 8 * 1024 * 1024
const LOG_TAIL_LINES = 300
const NETWORK_TIMEOUT_MS = 8_000

const TERMINAL_VARS = ["TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM", "COLORTERM", "WT_SESSION", "VSCODE_PID", "ConEmuPID", "TMUX", "STY", "SHELL", "ComSpec"]
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]
const SENSITIVE_FIELD = /pass|secret|token|key|credential|auth_token/i

export function redactContext(): RedactContext {
  let username: string | undefined
  try {
    username = os.userInfo().username
  } catch {
    username = process.env["USER"] ?? process.env["USERNAME"]
  }
  return { home: os.homedir(), username }
}

/** Presence of the terminal variables, with values kept only where they identify the terminal. */
function terminalFacts(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of TERMINAL_VARS) {
    const v = process.env[k]
    if (!v) continue
    out[k] = k === "VSCODE_PID" || k === "ConEmuPID" || k === "WT_SESSION" ? "set" : path.basename(v)
  }
  out["stdout is a terminal"] = process.stdout.isTTY ? "yes" : "no"
  return out
}

/** Proxy settings reduced to host:port; any credentials in them are dropped. */
function proxyFacts(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of PROXY_VARS) {
    const v = process.env[k]
    if (!v) continue
    if (k.toLowerCase() === "no_proxy") {
      out[k] = `${v.split(",").length} entr${v.split(",").length === 1 ? "y" : "ies"}`
      continue
    }
    try {
      const u = new URL(v)
      out[k] = `${u.protocol}//${u.host}`
    } catch {
      out[k] = "set (unparseable)"
    }
  }
  return out
}

/** Names of Altimate/OpenCode settings set in the environment; values only for plain on/off flags. */
function envFlags(): string[] {
  return Object.keys(process.env)
    .filter((k) => /^(ALTIMATE|OPENCODE)_/.test(k))
    .sort()
    .map((k) => {
      const v = process.env[k] ?? ""
      return /^(1|0|true|false)$/i.test(v) ? `${k}=${v}` : k
    })
}

function telemetryFacts(): Facts["telemetry"] {
  if (/^(1|true)$/i.test(process.env["ALTIMATE_TELEMETRY_DISABLED"] ?? "")) return { enabled: false, reason: "ALTIMATE_TELEMETRY_DISABLED is set" }
  if (/^(1|true)$/i.test(process.env["OPENCODE_DISABLE_TELEMETRY"] ?? "")) return { enabled: false, reason: "OPENCODE_DISABLE_TELEMETRY is set" }
  try {
    return Telemetry.isEnabled() ? { enabled: true } : { enabled: false, reason: "disabled in config, or not initialised" }
  } catch {
    return { enabled: false, reason: "could not be determined" }
  }
}

async function accountFacts(): Promise<Facts["account"]> {
  try {
    if (!(await AltimateApi.isConfigured())) return { configured: false }
    const c = await AltimateApi.getCredentials()
    return { configured: true, instance: c.altimateInstanceName, apiHost: new URL(c.altimateUrl).host }
  } catch {
    return { configured: false }
  }
}

async function connectionFacts(): Promise<ConnectionFact[]> {
  const out: ConnectionFact[] = []
  let names: string[] = []
  try {
    names = Registry.list().warehouses.map((w) => w.name)
  } catch {
    return out
  }
  for (const name of names) {
    const config = Registry.getConfig(name)
    if (!config) continue
    const auth = Registry.detectAuthMethod(config)
    const fact: ConnectionFact = {
      name,
      type: String(config.type ?? "unknown"),
      auth,
      fields: Object.keys(config)
        .filter((k) => config[k] !== undefined && config[k] !== "")
        .map((k) => (SENSITIVE_FIELD.test(k) ? `${k} (secret)` : k))
        .sort(),
    }
    if (needsPassword(fact)) {
      try {
        const resolved = await resolveConfig(name, config)
        fact.passwordAvailable = Boolean(resolved.password)
      } catch {
        fact.passwordAvailable = false
      }
    }
    out.push(fact)
  }
  return out
}

async function mcpFacts(): Promise<Facts["mcpServers"]> {
  try {
    const { Config } = await import("@/config/config")
    const cfg = (await Config.get()) as { mcp?: Record<string, { type?: string; enabled?: boolean }> }
    return Object.entries(cfg.mcp ?? {}).map(([name, v]) => ({ name, type: v?.type ?? "?", enabled: v?.enabled !== false }))
  } catch {
    return []
  }
}

/** DNS plus an HTTPS request with a short timeout; any HTTP status counts as reachable. */
export async function probe(target: string, host: string): Promise<NetworkCheck> {
  const started = Date.now()
  try {
    await dns.lookup(host)
  } catch (e) {
    return { target, host, ok: false, detail: `DNS lookup failed (${(e as NodeJS.ErrnoException).code ?? String(e)})`, ms: Date.now() - started }
  }
  try {
    const res = await fetch(`https://${host}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
    return { target, host, ok: true, detail: `HTTP ${res.status}`, ms: Date.now() - started }
  } catch (e) {
    const err = e as Error & { code?: string; cause?: { code?: string } }
    const reason = err.name === "TimeoutError" ? `no response within ${NETWORK_TIMEOUT_MS / 1000} s` : (err.cause?.code ?? err.code ?? err.message)
    return { target, host, ok: false, detail: reason, ms: Date.now() - started }
  }
}

/** Only endpoints Altimate Code already talks to: the warehouses configured here, the Altimate API, telemetry, and the model catalogue. */
function networkTargets(connections: ConnectionFact[], account: Facts["account"]): Array<{ target: string; host: string }> {
  const out: Array<{ target: string; host: string }> = []
  for (const c of connections) {
    if (c.type !== "snowflake") continue
    const account = Registry.getConfig(c.name)?.account
    if (typeof account === "string" && account && !account.includes("/")) {
      out.push({ target: `Snowflake (${c.name})`, host: account.includes(".") && account.endsWith("snowflakecomputing.com") ? account : `${account}.snowflakecomputing.com` })
    }
  }
  if (account.apiHost) out.push({ target: "Altimate API", host: account.apiHost })
  out.push({ target: "Telemetry", host: "eastus-8.in.applicationinsights.azure.com" })
  out.push({ target: "Model catalogue", host: "models.dev" })
  const seen = new Set<string>()
  return out.filter((t) => (seen.has(t.host) ? false : (seen.add(t.host), true)))
}

/** Reads at most the last LOG_READ_BYTES of the log, starting at a line boundary. */
export function readLogTail(file: string, maxBytes = LOG_READ_BYTES): string | undefined {
  try {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(file, "r")
    try {
      const buf = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      const text = buf.toString("utf-8")
      return start === 0 ? text : text.slice(text.indexOf("\n") + 1)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}

export async function collect(opts: { network: boolean }): Promise<Facts> {
  const ctx = redactContext()
  const [account, connections, mcpServers] = await Promise.all([accountFacts(), connectionFacts(), mcpFacts()])
  const network = opts.network
    ? await Promise.all(networkTargets(connections, account).map((t) => probe(t.target, t.host)))
    : []
  const logPath = path.join(Global.Path.log, "opencode.log")
  const logText = readLogTail(logPath)
  const lines = logText ? parseLog(logText) : []
  const tail = logText ? logText.split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL_LINES) : []
  let installMethod: string | undefined
  try {
    installMethod = resolveInstall().method
  } catch {
    installMethod = undefined
  }
  return {
    generatedAt: new Date().toISOString(),
    version: InstallationVersion,
    installMethod,
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    runtime: `Bun ${process.versions.bun ?? "?"}`,
    terminal: terminalFacts(),
    proxy: proxyFacts(),
    envFlags: envFlags(),
    debugMode: isDebugMode(),
    telemetry: telemetryFacts(),
    account,
    connections,
    mcpServers,
    network,
    logPath: redact(logPath, ctx),
    log: logText ? analyzeLog(lines) : undefined,
    logTail: tail.map((l) => redact(l, ctx)),
  }
}
// altimate_change end
