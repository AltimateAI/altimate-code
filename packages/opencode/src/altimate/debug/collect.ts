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
import { parse as parseJsonc } from "jsonc-parser"
import { env as flagEnv, truthy as flagTruthy } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { resolveInstall } from "@/installation"
import { Telemetry } from "@/altimate/telemetry"
import { AltimateApi } from "@/altimate/api/client"
import * as Registry from "@/altimate/native/connections/registry"
import { resolveConfig } from "@/altimate/native/connections/credential-store"
import { isDebugMode } from "./mode"
import { analyzeLog, needsPassword, parseLog, redact, withLiveness, type ConnectionFact, type Facts, type NetworkCheck, type RedactContext } from "./report"

/** Last part of the log read; enough for weeks of normal use without loading a huge file. */
const LOG_READ_BYTES = 8 * 1024 * 1024
const LOG_TAIL_LINES = 300
const NETWORK_TIMEOUT_MS = 8_000

const TERMINAL_VARS = ["TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM", "COLORTERM", "WT_SESSION", "VSCODE_PID", "ConEmuPID", "TMUX", "STY", "SHELL", "ComSpec"]
const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]
const SENSITIVE_FIELD = /pass|secret|token|key|credential|connection_string|ssl_|tls_/i

export function redactContext(): RedactContext {
  let username: string | undefined
  try {
    username = os.userInfo().username
  } catch {
    username = process.env["USER"] ?? process.env["USERNAME"]
  }
  let hostname: string | undefined
  try {
    hostname = os.hostname()
  } catch {
    hostname = undefined
  }
  return { home: os.homedir(), username, hostname }
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

/** With `network`, telemetry has been started by the CLI; its start is awaited here so the answer is not read
 * before it settles. Without, it is not started (it would send), so only the environment switches are checked. */
async function telemetryFacts(network: boolean): Promise<Facts["telemetry"]> {
  if (/^(1|true)$/i.test(process.env["ALTIMATE_TELEMETRY_DISABLED"] ?? "")) return { enabled: false, reason: "ALTIMATE_TELEMETRY_DISABLED is set" }
  if (/^(1|true)$/i.test(process.env["OPENCODE_DISABLE_TELEMETRY"] ?? "")) return { enabled: false, reason: "OPENCODE_DISABLE_TELEMETRY is set" }
  if (!network) return { enabled: false, checked: false, reason: "not started with --no-network" }
  try {
    await Telemetry.init()
    return Telemetry.isEnabled() ? { enabled: true } : { enabled: false, reason: "disabled in config" }
  } catch {
    return { enabled: false, checked: false, reason: "could not be determined" }
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
    // Names only: `Registry.list()` also queues a warehouse census for telemetry, which this command must not send.
    names = Registry.names()
  } catch {
    return out
  }
  for (const name of names) {
    const config = Registry.getConfig(name)
    if (!config) continue
    // The saved config has its secrets moved to the credential store, so it is classified as the driver will see
    // it: with those secrets filled back in. Classified as saved, a working token or key connection read as having
    // no sign-in at all.
    let resolved = config
    let resolveFailed = false
    try {
      resolved = await resolveConfig(name, config)
    } catch {
      resolveFailed = true
    }
    out.push(connectionFact(name, config, resolveFailed ? undefined : resolved))
  }
  return out
}

/** A connection as the report describes it. `resolved` is the saved config with secrets from the credential store
 * filled in; undefined when the store could not be read. */
export function connectionFact(name: string, config: Record<string, unknown>, resolved: Record<string, unknown> | undefined): ConnectionFact {
  const present = (c: Record<string, unknown>, k: string) => c[k] !== undefined && c[k] !== ""
  const effective = resolved ?? config
  const fact: ConnectionFact = {
    name,
    type: String(config.type ?? "unknown"),
    auth: Registry.detectAuthMethod(effective as never),
    fields: Object.keys(effective)
      .filter((k) => present(effective, k))
      .map((k) => (SENSITIVE_FIELD.test(k) ? `${k} (secret${present(config, k) ? "" : ", in credential store"})` : k))
      .sort(),
  }
  if (needsPassword(fact)) fact.passwordAvailable = resolved !== undefined && credentialFieldsFor(fact.type).some((k) => present(resolved, k))
  return fact
}

/** Fields that sign a connection in on their own, for the driver of each warehouse type: a field the driver does
 * not read (a Postgres config with `credentials_path`) does not make that connection usable. */
const COMMON_CREDENTIALS = ["password", "connection_string"]
const CREDENTIALS_BY_TYPE: Record<string, string[]> = {
  snowflake: ["private_key", "privateKey", "private_key_path", "privateKeyPath", "token", "access_token"],
  databricks: ["token", "access_token"],
  bigquery: ["credentials_json", "keyfile_json", "credentials_path", "keyfile"],
}

export function credentialFieldsFor(type: string): string[] {
  return [...COMMON_CREDENTIALS, ...(CREDENTIALS_BY_TYPE[type] ?? [])]
}

/** Where config can come from, in the config loader's merge order (later wins). Replaceable in tests. */
export interface ConfigSources {
  global: string
  /** The folder the bundle runs in. */
  cwd: string
  home: string
  /** `ALTIMATE_CLI_CONFIG` / `OPENCODE_CONFIG`: one extra file. */
  file?: string
  /** `ALTIMATE_CLI_CONFIG_DIR` / `OPENCODE_CONFIG_DIR`: one extra folder. */
  dir?: string
  /** `OPENCODE_DISABLE_PROJECT_CONFIG`: the project's own files are not read. */
  noProject?: boolean
  /** `ALTIMATE_CLI_CONFIG_CONTENT` / `OPENCODE_CONFIG_CONTENT`: inline JSON. */
  content?: string
}

function defaultSources(): ConfigSources {
  return {
    global: Global.Path.config,
    cwd: process.cwd(),
    home: Global.Path.home,
    // Read as the loader reads them: the documented ALTIMATE_CLI_* name first, then the OPENCODE_* fallback.
    file: flagEnv("OPENCODE_CONFIG") || undefined,
    dir: flagEnv("OPENCODE_CONFIG_DIR") || undefined,
    content: flagEnv("OPENCODE_CONFIG_CONTENT") || undefined,
    noProject: flagTruthy("OPENCODE_DISABLE_PROJECT_CONFIG"),
  }
}

/** The git root above `start` (the loader's project boundary). Outside a repository the project's worktree is the
 * filesystem root, so every ancestor counts. */
function projectRoot(start: string): string {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir
    if (path.dirname(dir) === dir) return dir
  }
}

/** Folders from `from` up to `to`, nearest first. */
function upwards(from: string, to: string): string[] {
  const out: string[] = []
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    out.push(dir)
    if (dir === path.resolve(to) || path.dirname(dir) === dir) return out
  }
}

/** Config files in the order `config/config.ts` merges them (see `ConfigPaths.directories` and `files`). */
export function configFiles(src: ConfigSources): string[] {
  const root = projectRoot(src.cwd)
  const inDir = (dir: string) => ["altimate-code.json", "altimate-code.jsonc", "opencode.json", "opencode.jsonc"].map((n) => path.join(dir, n))
  const configDirs = [
    ...(src.noProject ? [] : upwards(src.cwd, root).flatMap((d) => [path.join(d, ".altimate-code"), path.join(d, ".opencode")])),
    path.join(src.home, ".altimate-code"),
    path.join(src.home, ".opencode"),
    ...(src.dir ? [src.dir] : []),
  ]
  return [
    ...["config.json", "opencode.json", "opencode.jsonc", "altimate-code.json", "altimate-code.jsonc"].map((n) => path.join(src.global, n)),
    ...(src.file ? [src.file] : []),
    // Project files from the root down, so the folder the bundle runs in wins; in one folder `.jsonc` wins.
    ...(src.noProject
      ? []
      : upwards(src.cwd, root)
          .reverse()
          .flatMap((d) => [path.join(d, "opencode.json"), path.join(d, "opencode.jsonc")])),
    ...[...new Set(configDirs)].flatMap(inDir),
  ]
}

type McpEntry = { type?: string; enabled?: boolean }
type RawMcpEntry = McpEntry & { command?: unknown; args?: unknown; url?: unknown }

/** A config's MCP servers as `normalizeMcpConfig` in config/config.ts leaves them: `mcpServers` only when there is no
 * `mcp`, entries that are not objects dropped, and the type inferred from `command`/`args` (local) or `url` (remote). */
function mcpOf(cfg: unknown): Record<string, McpEntry> {
  if (!cfg || typeof cfg !== "object") return {}
  const c = cfg as { mcp?: unknown; mcpServers?: unknown }
  const raw = ("mcp" in c ? c.mcp : c.mcpServers) as Record<string, RawMcpEntry> | undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, McpEntry> = {}
  for (const [name, e] of Object.entries(raw)) {
    if (!e || typeof e !== "object") continue
    const type = e.command || e.args ? "local" : typeof e.url === "string" && e.url ? "remote" : e.type
    out[name] = { ...(type ? { type } : {}), ...(typeof e.enabled === "boolean" ? { enabled: e.enabled } : {}) }
  }
  return out
}

/**
 * MCP servers, read straight from the config sources in the loader's merge order, each server's fields merged as
 * the loader merges them. The full loader needs a project instance, which the bundle deliberately does not start
 * (it runs plugins and can hang the way the bundle is meant to diagnose). undefined when nothing could be read.
 */
export function mcpFacts(src: ConfigSources = defaultSources()): Facts["mcpServers"] {
  const servers = new Map<string, McpEntry>()
  let read = false
  const apply = (cfg: unknown) => {
    read = true
    for (const [name, v] of Object.entries(mcpOf(cfg))) servers.set(name, { ...servers.get(name), ...v })
  }
  for (const file of configFiles(src)) {
    let text: string
    try {
      text = fs.readFileSync(file, "utf-8")
    } catch {
      continue
    }
    const cfg = parseJsonc(text)
    if (cfg && typeof cfg === "object") apply(cfg)
  }
  if (src.content) {
    const cfg = parseJsonc(src.content)
    if (cfg && typeof cfg === "object") apply(cfg)
  }
  if (!read) return undefined
  return [...servers.entries()]
    .map(([name, v]) => ({ name, type: v.type ?? "?", enabled: v.enabled !== false }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface ProbeDeps {
  lookup: (host: string) => Promise<unknown>
  fetch: (url: string, init: RequestInit) => Promise<{ status: number }>
}

const defaultProbeDeps: ProbeDeps = { lookup: (host) => dns.lookup(host), fetch: (url, init) => fetch(url, init) }

/**
 * An HTTPS request to `host`, preceded by a DNS lookup unless a proxy is set (behind a proxy the machine may have no
 * external DNS at all, and the proxy resolves the name). One deadline covers both steps; any HTTP status counts as
 * reachable.
 */
export async function probe(
  target: string,
  host: string,
  opts: { proxy?: boolean; timeoutMs?: number } = {},
  deps: ProbeDeps = defaultProbeDeps,
): Promise<NetworkCheck> {
  const timeoutMs = opts.timeoutMs ?? NETWORK_TIMEOUT_MS
  const started = Date.now()
  const deadline = AbortSignal.timeout(timeoutMs)
  const timedOut = new Promise<never>((_, reject) =>
    deadline.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), { once: true }),
  )
  timedOut.catch(() => {})
  const noAnswer = `no response within ${timeoutMs / 1000} s`
  if (!opts.proxy) {
    try {
      await Promise.race([deps.lookup(host), timedOut])
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      return { target, host, ok: false, detail: err.name === "TimeoutError" ? `DNS lookup: ${noAnswer}` : `DNS lookup failed (${err.code ?? String(e)})`, ms: Date.now() - started }
    }
  }
  try {
    const res = await Promise.race([deps.fetch(`https://${host}/`, { method: "HEAD", redirect: "manual", signal: deadline }), timedOut])
    return { target, host, ok: true, detail: `HTTP ${res.status}`, ms: Date.now() - started }
  } catch (e) {
    const err = e as Error & { code?: string; cause?: { code?: string } }
    const reason = err.name === "TimeoutError" || err.name === "AbortError" ? noAnswer : (err.cause?.code ?? err.code ?? err.message)
    return { target, host, ok: false, detail: reason, ms: Date.now() - started }
  }
}

/** The telemetry ingestion host this install would send to: the connection-string override, else the built-in one. */
function telemetryHost(): string {
  const cs = process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"]
  const endpoint = cs?.split(";").find((p) => p.trim().startsWith("IngestionEndpoint="))?.split("=")[1]
  try {
    // The hostname alone: a port in the endpoint is not part of the name DNS resolves.
    if (endpoint) return new URL(endpoint).hostname
  } catch {
    // fall through to the built-in endpoint
  }
  return "eastus-8.in.applicationinsights.azure.com"
}

/** Only endpoints Altimate Code already talks to over HTTPS: Snowflake and Databricks warehouses configured here, the
 * Altimate API, telemetry when it is on, and the model catalogue. Other warehouses speak their own protocols on
 * their own ports, so an HTTPS check would report them unreachable when they are fine. */
function networkTargets(connections: ConnectionFact[], account: Facts["account"], telemetry: Facts["telemetry"]): Array<{ target: string; host: string }> {
  const out: Array<{ target: string; host: string }> = []
  for (const c of connections) {
    const config = Registry.getConfig(c.name)
    if (c.type === "snowflake") {
      const acct = config?.account
      if (typeof acct === "string" && acct && !acct.includes("/")) {
        // Only a real Snowflake domain is probed as given; anything else is treated as an account locator.
        const host = acct.toLowerCase().endsWith(".snowflakecomputing.com") ? acct : `${acct}.snowflakecomputing.com`
        if (/^[A-Za-z0-9.-]+$/.test(host)) out.push({ target: `Snowflake (${c.name})`, host })
      }
    }
    if (c.type === "databricks") {
      // The same aliases the driver accepts (normalizeConfig maps serverHostname to server_hostname).
      const h = config?.server_hostname ?? config?.serverHostname ?? config?.host
      if (typeof h === "string" && h && !h.includes("/")) out.push({ target: `Databricks (${c.name})`, host: h })
    }
  }
  if (account.apiHost) out.push({ target: "Altimate API", host: account.apiHost })
  if (telemetry.enabled) out.push({ target: "Telemetry", host: telemetryHost() })
  out.push({ target: "Model catalogue", host: "models.dev" })
  const seen = new Set<string>()
  return out.filter((t) => (seen.has(t.host) ? false : (seen.add(t.host), true)))
}

/** Whether process `pid` is still running. A permission error means it exists under another user. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
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
  const mcpServers = mcpFacts()
  const [account, connections, telemetry] = await Promise.all([accountFacts(), connectionFacts(), telemetryFacts(opts.network)])
  const proxy = PROXY_VARS.some((k) => k.toLowerCase() !== "no_proxy" && process.env[k])
  const network = opts.network
    ? await Promise.all(networkTargets(connections, account, telemetry).map((t) => probe(t.target, t.host, { proxy })))
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
    telemetry,
    account,
    connections,
    mcpServers,
    network,
    logPath: redact(logPath, ctx),
    log: logText ? withLiveness(analyzeLog(lines), pidAlive) : undefined,
    logTail: tail.map((l) => redact(l, ctx)),
  }
}
// altimate_change end
