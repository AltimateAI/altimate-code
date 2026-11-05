// altimate_change - new file
//
// One-click local integrations: detection of existing credentials, local storage and the sync of a
// credential to the caller's own workspace connection. Offline (mock or demo) the workspace side is
// simulated: nothing is sent anywhere, the request that would be made is recorded in a local file.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import childProcess, { spawnSync } from "node:child_process"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "../../global"
import { IntegrationsBackend as backend } from "./backend"
import { IntegrationsCredentials as creds } from "./credentials"
import { AltimateApi } from "../api/client"
import { resolveBinding, resolveBindingOutcome } from "../workspace/state"
import { workspaceLabel } from "../workspace/workspace-name"

export type ProviderId = "github" | "jira" | "linear"
export const PROVIDER_IDS: ProviderId[] = ["github", "jira", "linear"]
export const PROVIDER_NAMES: Record<ProviderId, string> = { github: "GitHub", jira: "Jira", linear: "Linear" }
export const INTEGRATION_IDS: Record<ProviderId, string> = { github: "github", jira: "jira", linear: "linear" }

export type SourceKind = "cli" | "env" | "mcp" | "mcp-remote" | "browser"
export interface Source {
  kind: SourceKind
  label: string
}
export type ProviderState = "connected" | "expired" | "rejected" | "detected" | "available" | "not_found"
export type SyncState = "synced" | "local" | "pending" | "blocked"

export interface Detection {
  id: ProviderId
  source: Source
  account: string | null
  syncable: boolean
  note: string | null
}

export interface ProviderStatus {
  id: ProviderId
  name: string
  state: ProviderState
  source: Source | null
  account: string | null
  syncable: boolean
  sync: SyncState
  updatedAt: string | null
  expiresAt: string | null
  note: string | null
  /** False for a connection made by hand in the web app: shown, but this tool does not manage it. */
  managed?: boolean
  /** A credential found on this machine while the row shows a connection made by hand in the web app: it can still be connected here. */
  found?: { source: Source; account: string | null }
}

export interface StatusResult {
  workspace: WorkspaceInfo
  providers: ProviderStatus[]
  /** Why the workspace could not be read; the states shown then come from this machine and may be out of date. */
  workspaceUnchecked?: string
}

export interface StoredProvider {
  detection?: Detection
  registered?: boolean
  account?: string | null
  source?: Source
  synced?: boolean
  updatedAt?: string
  /** ISO time the access token stops working. Never a secret. */
  expiresAt?: string | null
  /** Workspace connection id when the credential was saved to the workspace. */
  connectionId?: number | null
  /** Credential form: non-secret values typed in but not yet connected. Secrets live in the secret store. */
  drafts?: Record<string, string>
  /** Credential form: the non-secret values of the connected credentials. */
  values?: Record<string, string>
  /** Credential form: names of the secret fields kept under `credentialKey`. */
  secretFields?: string[]
  variant?: string
  validatedAt?: string
  /** Changes whenever the credential is saved, so a step prepared from an older save can tell it was replaced. */
  credentialStamp?: string
  /** The last validation was refused by the provider. */
  rejected?: boolean
  /** Kept on this machine while the provider could not be reached to check it. */
  unverified?: boolean
}
export interface Store {
  blocked: Partial<Record<ProviderId, boolean>>
  providers: Partial<Record<ProviderId, StoredProvider>>
}

const REJECTED_NOTE = "Token rejected, update it"
const REMOVED_NOTE = "The workspace connection was removed. Add the credentials again."
export const demoMode = () => process.env.ALTIMATE_INTEGRATIONS_DEMO === "1"
export const mockMode = () => process.env.ALTIMATE_INTEGRATIONS_MOCK === "1" || demoMode()
/** Backend login when real mode applies: signed in to Altimate and no mock switch set. */
export async function realConfig(): Promise<backend.BackendConfig | null> {
  if (mockMode()) return null
  return backend.backendConfig()
}
export const EXPIRY_SKEW_MS = 60_000
/** A token at or past `expiresAt - 60s` counts as expired. */
export function isExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false
  const at = Date.parse(expiresAt)
  return !Number.isNaN(at) && at <= now + EXPIRY_SKEW_MS
}
export const dataDir = () => process.env.ALTIMATE_INTEGRATIONS_DIR || Global.Path.data
export const homeDir = () => process.env.ALTIMATE_INTEGRATIONS_HOME || os.homedir()
const statePath = () => path.join(dataDir(), "integrations.json")
const remotePath = () => path.join(dataDir(), "integrations-remote-mock.json")
const secretsPath = () => path.join(dataDir(), "integrations-secrets.json")
const KEYCHAIN_SERVICE = "altimate-code-integrations"
const useKeychain = () => process.platform === "darwin" && !process.env.ALTIMATE_INTEGRATIONS_DIR

export function isProvider(value: string): value is ProviderId {
  return (PROVIDER_IDS as string[]).includes(value)
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}
/** Like readJson, but only a missing file gives the fallback. A file that exists and cannot be read or parsed is an error: the next write would otherwise replace it with an empty one and lose the policy or secrets it held. */
export function readJsonStrict<T>(file: string, fallback: T): T {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return fallback
    throw new Error(`Could not read ${file} (${e instanceof Error ? e.message : String(e)}). Fix or remove it, then run the command again.`)
  }
  const fail = (why: string) => new Error(`Could not read ${file} (${why}). Fix or remove it, then run the command again.`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw fail(e instanceof Error ? e.message : String(e))
  }
  if (typeof fallback === "object" && fallback !== null && !Array.isArray(fallback) && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) throw fail("expected a JSON object")
  return parsed as T
}
/** Writes through a temp file in the same directory and renames it over the target, so a reader or a crash never sees half a file. The mode is set when the file is created; the temp file never outlives a failed write. */
export function writeJson(file: string, value: unknown, mode = 0o666) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  const fd = fs.openSync(tmp, "wx", mode)
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2))
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

const lockScope = new AsyncLocalStorage<true>()
/** A lock whose holder stopped refreshing it is taken over after this long; kept well under the shortest time a caller waits on the CLI, so a killed run does not block the next one. */
const LOCK_STALE_MS = 12_000
/** How long a call waits for the lock before it gives up; the plugin allows more than this plus the network budget of the call. */
export const LOCK_WAIT_MS = 30_000
/** Runs `fn` with other CLI processes kept out. The lock is held for everything `fn` does, including workspace network calls, not only local file reads and writes. Re-entrant within the running task. */
export async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  if (lockScope.getStore()) return fn()
  return Flock.withLock("altimate-integrations", () => lockScope.run(true, async () => fn()), { dir: path.join(dataDir(), "locks"), staleMs: LOCK_STALE_MS, timeoutMs: LOCK_WAIT_MS })
}
/** Loads the state, lets `fn` change it, and saves it, all under the lock. */
export function updateStore<T>(fn: (store: Store) => T): Promise<T> {
  return withLock(() => {
    const store = loadStore()
    const result = fn(store)
    saveStore(store)
    return result
  })
}

export function loadStore(): Store {
  const raw = readJsonStrict<Partial<Store>>(statePath(), {})
  return { blocked: raw.blocked ?? {}, providers: raw.providers ?? {} }
}
export function saveStore(store: Store) {
  writeJson(statePath(), store, 0o600)
}

// ---------------------------------------------------------------- secrets

/** Secret-store account for a credential field; the draft and the connected copy are kept apart. */
export const secretKey = (kind: "draft" | "cred", id: ProviderId, field: string) => `${kind}:${id}:${field}`
/** The fields a provider is known to hold as secrets, before the workspace catalog is read. */
export const BUILTIN_SECRET_FIELDS: Record<ProviderId, string[]> = {
  github: ["github_token"],
  jira: ["jiraApiToken", "jiraPatToken"],
  linear: ["linearApiKey"],
}

/** How long one `security` call may take; tests shorten it. */
export const keychainLimits = { timeoutMs: 10_000 }

interface SecurityResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}
/** Runs the macOS `security` tool without blocking the event loop, so the lock's refresh timer keeps firing while the keychain answers. Output is only collected when asked for; `input` goes to stdin. */
function runSecurity(args: string[], opts: { input?: string; stdout?: boolean; stderr?: boolean } = {}): Promise<SecurityResult> {
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    let settled = false
    const done = (r: SecurityResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    let child: ReturnType<typeof childProcess.spawn>
    try {
      child = childProcess.spawn("security", args, {
        stdio: [opts.input !== undefined ? "pipe" : "ignore", opts.stdout ? "pipe" : "ignore", opts.stderr ? "pipe" : "ignore"],
      })
    } catch (e) {
      resolve({ status: null, stdout: "", stderr: "", error: e instanceof Error ? e : new Error(String(e)) })
      return
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done({ status: null, stdout: out, stderr: err, error: new Error("timed out") })
    }, keychainLimits.timeoutMs)
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (d: string) => (out += d))
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (d: string) => (err += d))
    child.on("error", (e) => done({ status: null, stdout: out, stderr: err, error: e }))
    child.on("close", (code) => done({ status: code, stdout: out, stderr: err }))
    if (opts.input !== undefined) {
      child.stdin?.on("error", () => {})
      child.stdin?.end(opts.input)
    }
  })
}

export async function storeSecret(id: string, secret: string) {
  // A token is one line. A line break cannot be quoted for `security -i` either, so such a value is refused rather than parked in a file.
  if (/[\r\n]/.test(secret)) throw new Error("The value is not a token: it contains a line break")
  if (useKeychain()) {
    if (!/^[A-Za-z0-9:._-]+$/.test(id)) throw new Error("The credential id is not valid")
    // The secret goes to `security -i` on stdin so it never shows in the process list. On macOS it is kept in the keychain only; a failed write is an error, never a plaintext file.
    const quote = (v: string) => `"${v.replace(/[\\"]/g, "\\$&")}"`
    const r = await runSecurity(["-i"], { input: `add-generic-password -U -s ${quote(KEYCHAIN_SERVICE)} -a ${quote(id)} -w ${quote(secret)}\n` })
    if (r.status !== 0) throw new Error("Could not save the credential to the macOS keychain, so nothing was stored. Unlock the keychain and try again.")
    return
  }
  await withLock(() => {
    const all = readJsonStrict<Record<string, string>>(secretsPath(), {})
    all[id] = secret
    writeJson(secretsPath(), all, 0o600)
  })
}
/** `security` exits with this when the item does not exist. */
const KEYCHAIN_ITEM_NOT_FOUND = 44
// Only the exit code is trusted: other failures (a missing keychain, exit 50) print similar "could not be found" text.
const keychainItemMissing = (r: SecurityResult) => r.status === KEYCHAIN_ITEM_NOT_FOUND
const keychainDetail = (r: SecurityResult) => (r.error ? `: ${r.error.message}` : r.status != null ? ` (exit ${r.status})` : "")

export async function readSecret(id: string): Promise<string | undefined> {
  if (useKeychain()) {
    const r = await runSecurity(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-w"], { stdout: true })
    if (r.status === 0) return r.stdout.trim()
    // Only a missing item means no secret: a locked, failing or timed-out keychain must not read as empty, or the caller would replace or delete what is stored.
    if (!keychainItemMissing(r)) throw new Error(`Could not read a stored credential from the macOS keychain${keychainDetail(r)}. Unlock the keychain and try again.`)
  }
  return readJsonStrict<Record<string, string>>(secretsPath(), {})[id]
}
export async function deleteSecret(id: string) {
  if (useKeychain()) {
    const r = await runSecurity(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id])
    if (r.status !== 0 && !keychainItemMissing(r)) throw new Error(`Could not remove a stored credential from the macOS keychain${keychainDetail(r)}`)
  }
  await withLock(() => {
    const all = readJsonStrict<Record<string, string>>(secretsPath(), {})
    if (id in all) {
      delete all[id]
      writeJson(secretsPath(), all, 0o600)
    }
  })
}
/** Removes every draft and connected secret kept for a provider's credential form, of every variant it can have; fields in `keep` keep their connected secret. */
export async function purgeCredentialSecrets(id: ProviderId, rec?: StoredProvider, includeDrafts = true, keep: Set<string> = new Set()) {
  const catalog = await creds.catalogSecretFields(id)
  await withLock(async () => {
    for (const field of new Set([...BUILTIN_SECRET_FIELDS[id], ...catalog, ...(rec?.secretFields ?? [])])) {
      if (includeDrafts) await deleteSecret(secretKey("draft", id, field))
      if (!keep.has(field)) await deleteSecret(secretKey("cred", id, field))
    }
  })
}

/** Claude MCP server maps the user set up themselves: user level and this project's entry in ~/.claude.json. A repository's own `.mcp.json` is not among them, as whoever controls the repository can write it; it only signals presence in `detectFromClaudeConfigs`. */
export function mcpServerMaps(home: string, cwd: string): { scope: "user" | "project"; servers: Record<string, McpServer> }[] {
  const claude = readJson<any>(path.join(home, ".claude.json"), {})
  return [
    { scope: "user", servers: claude.mcpServers ?? {} },
    { scope: "project", servers: claude.projects?.[cwd]?.mcpServers ?? {} },
  ]
}
export const providerMatchesMcp = (id: ProviderId, name: string, server: McpServer) =>
  MCP_MATCHERS[id].test([name, server.command, server.url, ...(server.args ?? [])].filter(Boolean).join(" "))

// ---------------------------------------------------------------- detection

export interface McpServer {
  command?: string
  args?: string[]
  url?: string
  type?: string
  env?: Record<string, string>
}

const MCP_MATCHERS: Record<ProviderId, RegExp> = {
  github: /github/i,
  jira: /atlassian|jira/i,
  linear: /linear/i,
}

const PROJECT_MCP_ORIGIN = ".mcp.json"

/** Detections from parsed Claude MCP server maps. Pure: reads nothing from disk. */
export function detectFromMcpServers(servers: Record<string, McpServer>, origin: string): Detection[] {
  const found: Detection[] = []
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!server || typeof server !== "object") continue
    const haystack = [name, server.command, server.url, ...(server.args ?? [])].filter(Boolean).join(" ")
    for (const id of PROVIDER_IDS) {
      if (!MCP_MATCHERS[id].test(haystack)) continue
      const remote = Boolean(server.url) || server.type === "http" || server.type === "sse"
      const hasToken = creds.mcpEnvHasToken(id, server.env)
      if (remote) {
        found.push({
          id,
          source: { kind: "mcp-remote", label: `Claude MCP (${name})` },
          account: null,
          syncable: false,
          note: "usable in Claude; connect in browser to sync",
        })
      } else if (hasToken && origin === PROJECT_MCP_ORIGIN) {
        found.push({
          id,
          source: { kind: "mcp-remote", label: `Claude MCP (${name})` },
          account: null,
          syncable: false,
          note: "usable in Claude; its token is not read from a repository file, set it in your environment to sync",
        })
      } else if (hasToken) {
        found.push({
          id,
          source: { kind: "mcp", label: `Claude MCP (${name})` },
          account: null,
          syncable: true,
          note: `token from ${origin}`,
        })
      }
    }
  }
  return found
}

export function detectFromClaudeConfigs(home: string, cwd: string): Detection[] {
  const out: Detection[] = []
  const claude = readJson<any>(path.join(home, ".claude.json"), {})
  out.push(...detectFromMcpServers(claude.mcpServers ?? {}, "~/.claude.json"))
  out.push(...detectFromMcpServers(claude.projects?.[cwd]?.mcpServers ?? {}, "~/.claude.json"))
  try {
    const project = JSON.parse(fs.readFileSync(path.join(cwd, ".mcp.json"), "utf8"))
    out.push(...detectFromMcpServers(project.mcpServers ?? {}, PROJECT_MCP_ORIGIN))
  } catch {}
  return out
}

/** Reads `server` and `login` from a jira-cli config without a YAML dependency. */
export function parseJiraCliConfig(text: string): { server?: string; login?: string } {
  const pick = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s*['"]?([^'"\\n]+?)['"]?\\s*$`, "m"))
    return m?.[1]
  }
  return { server: pick("server"), login: pick("login") }
}

function onPath(bin: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore", timeout: 2000 })
  return r.status === 0
}

function detectGithub(): Detection | undefined {
  const auth = spawnSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 5000 })
  if (auth.status === 0) {
    const who = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
    const login = who.status === 0 ? who.stdout.trim() : ""
    return { id: "github", source: { kind: "cli", label: "gh CLI" }, account: login || null, syncable: true, note: null }
  }
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
    return { id: "github", source: { kind: "env", label: process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "GH_TOKEN" }, account: null, syncable: true, note: null }
  }
}

function detectJira(home: string): Detection | undefined {
  try {
    const cfg = parseJiraCliConfig(fs.readFileSync(path.join(home, ".config/.jira/.config.yml"), "utf8"))
    if (cfg.server || cfg.login)
      return { id: "jira", source: { kind: "cli", label: "jira-cli" }, account: cfg.login ?? null, syncable: true, note: cfg.server ? `site ${cfg.server}` : null }
  } catch {}
  if (process.env.JIRA_API_TOKEN)
    return { id: "jira", source: { kind: "env", label: "JIRA_API_TOKEN" }, account: process.env.JIRA_USER ?? null, syncable: true, note: null }
  if (onPath("acli")) return { id: "jira", source: { kind: "cli", label: "acli" }, account: null, syncable: true, note: null }
}

function detectLinear(): Detection | undefined {
  if (process.env.LINEAR_API_KEY)
    return { id: "linear", source: { kind: "env", label: "LINEAR_API_KEY" }, account: null, syncable: true, note: null }
  if (onPath("linear")) return { id: "linear", source: { kind: "cli", label: "linear CLI" }, account: null, syncable: true, note: null }
}

export function demoDetections(): Detection[] {
  return [
    { id: "github", source: { kind: "cli", label: "gh CLI" }, account: "demo-user", syncable: true, note: null },
    { id: "jira", source: { kind: "cli", label: "jira-cli" }, account: "demo-user@example.com", syncable: true, note: "site https://demo.atlassian.net" },
    {
      id: "linear",
      source: { kind: "mcp-remote", label: "Claude MCP (linear)" },
      account: null,
      syncable: false,
      note: "usable in Claude; connect in browser to sync",
    },
  ]
}

/** Best detection per provider: direct sources win over Claude MCP servers. */
export function scan(cwd = process.cwd()): Detection[] {
  if (demoMode()) return demoDetections()
  const home = homeDir()
  const direct = [detectGithub(), detectJira(home), detectLinear()].filter((d): d is Detection => Boolean(d))
  const mcp = detectFromClaudeConfigs(home, cwd)
  const best = new Map<ProviderId, Detection>()
  for (const d of [...direct, ...mcp.sort((a, b) => Number(b.syncable) - Number(a.syncable))]) if (!best.has(d.id)) best.set(d.id, d)
  return PROVIDER_IDS.flatMap((id) => (best.has(id) ? [best.get(id)!] : []))
}

export function recordDetections(found: Detection[]): Promise<Store> {
  return updateStore((store) => {
    for (const id of PROVIDER_IDS) {
      const d = found.find((f) => f.id === id)
      const prev = store.providers[id] ?? {}
      if (d) store.providers[id] = { ...prev, detection: d, updatedAt: new Date().toISOString() }
      else if (!prev.registered && !prev.drafts) delete store.providers[id]
      else store.providers[id] = { ...prev, detection: undefined }
    }
    return store
  })
}

// ---------------------------------------------------------------- status

export interface WorkspaceInfo {
  name: string
  tenant: string
  /** Whether this directory is linked to a workspace. */
  linked: boolean
  /** The linked workspace id; null when not linked or offline. */
  id: number | null
  /** Whether an Altimate login exists; without one everything stays on this machine. */
  signedIn: boolean
}

export function workspaceInfo(): WorkspaceInfo {
  if (mockMode()) return { name: "Altimate Demo", tenant: "altimate", linked: true, id: null, signedIn: true }
  return { name: "not signed in", tenant: "", linked: false, id: null, signedIn: false }
}

/** The workspace being talked to: the real tenant and, when this directory is linked, the linked workspace's name. */
export async function liveWorkspaceInfo(): Promise<WorkspaceInfo> {
  const cfg = await realConfig()
  if (!cfg) return workspaceInfo()
  const binding = await resolveBinding(process.cwd()).catch(() => null)
  return { name: binding?.datamateName || cfg.tenant, tenant: cfg.tenant, linked: Boolean(binding), id: binding?.datamateId ?? null, signedIn: true }
}

function orderStatus(p: ProviderStatus): ProviderStatus {
  return { id: p.id, name: p.name, state: p.state, source: p.source, account: p.account, syncable: p.syncable, sync: p.sync, updatedAt: p.updatedAt, expiresAt: p.expiresAt, note: p.note, ...(p.managed === false ? { managed: false } : {}), ...(p.found ? { found: p.found } : {}) }
}

export function buildStatus(store: Store, overlay: Detection[] = [], now = Date.now()): StatusResult {
  const providers = PROVIDER_IDS.map((id): ProviderStatus => orderStatus(compute(id)))
  function compute(id: ProviderId): ProviderStatus {
    const rec = store.providers[id]
    const det = rec?.detection ?? overlay.find((d) => d.id === id)
    const blocked = Boolean(store.blocked[id])
    const base = { id, name: PROVIDER_NAMES[id], updatedAt: rec?.updatedAt ?? null, expiresAt: rec?.registered ? (rec.expiresAt ?? null) : null }
    if (rec?.registered) {
      const source = rec.source ?? det?.source ?? null
      const expired = isExpired(rec.expiresAt, now)
      const rejected = !expired && Boolean(rec.rejected)
      return {
        ...base,
        state: expired ? "expired" : rejected ? "rejected" : "connected",
        source,
        account: rec.account ?? det?.account ?? null,
        syncable: true,
        sync: blocked ? "blocked" : rec.synced ? "synced" : "local",
        note: rejected ? REJECTED_NOTE : rec.unverified ? "not verified yet, the provider could not be reached" : blocked ? "kept local by policy" : expired ? "access expired, reconnect to continue" : null,
      }
    }
    if (!det) return { ...base, state: "not_found", source: null, account: null, syncable: true, sync: blocked ? "blocked" : "local", note: null }
    if (det.source.kind === "mcp-remote")
      return { ...base, state: "available", source: det.source, account: det.account, syncable: false, sync: blocked ? "blocked" : "local", note: det.note }
    return {
      ...base,
      state: "detected",
      source: det.source,
      account: det.account,
      syncable: det.syncable,
      sync: blocked ? "blocked" : "pending",
      note: blocked ? "kept local by policy" : det.note,
    }
  }
  return { workspace: workspaceInfo(), providers }
}

export function status(): StatusResult {
  return buildStatus(loadStore(), demoMode() ? demoDetections() : [])
}

/** One provider as the workspace shows it, derived from the caller's own connections. */
export interface RemoteProvider {
  integration_id: string
  connection_id: number | null
  name: string
  account: string | null
  /** True when the connection shown is the one this tool made (named after this machine). */
  managed: boolean
  /** The connection this tool made for the provider, shown or not; null when there is none. */
  managedId?: number | null
  /** Expiry and validity of the connection this tool made, which can differ from the one shown. */
  managedExpiresAt?: string | null
  managedValid?: boolean | null
  source: { kind?: string; label?: string } | null
  expires_at: string | null
  expired: boolean
  is_valid: boolean | null
}

/** The name this tool gives its connection for a provider on this machine. */
export const managedName = (id: ProviderId, host = os.hostname()) => `${PROVIDER_NAMES[id]} (from ${host})`

/** The expiry the workspace keeps in the connection's config, when it has one. */
const connectionExpiry = (c: backend.Connection): string | null => {
  const v = c.config?.expires_at
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null
}

const validatedAt = (c: backend.Connection) => Date.parse(c.last_validated_at ?? "") || 0

/** The connection this tool manages for a provider: matched on integration and name. */
export function findManaged(connections: backend.Connection[], id: ProviderId, host = os.hostname()): backend.Connection | undefined {
  const name = managedName(id, host)
  return connections.filter((c) => c.integration_id === INTEGRATION_IDS[id] && c.name === name).sort((a, b) => b.id - a.id)[0]
}

/**
 * The remote state of each provider from the caller's own connections. What is shown comes from the
 * most recently validated one (the managed one on a tie); `managedId` is the connection this tool
 * made, which update, disconnect and the removed-connection check follow.
 */
export function deriveRemote(connections: backend.Connection[], host = os.hostname()): RemoteProvider[] {
  const out: RemoteProvider[] = []
  for (const id of PROVIDER_IDS) {
    const own = connections.filter((c) => c.integration_id === INTEGRATION_IDS[id])
    const managed = findManaged(connections, id, host)
    const pick = own.sort((a, b) => validatedAt(b) - validatedAt(a) || Number(b.id === managed?.id) - Number(a.id === managed?.id) || b.id - a.id)[0]
    if (!pick) continue
    out.push({
      integration_id: id,
      connection_id: pick.id,
      name: pick.name,
      account: null,
      managed: pick.id === managed?.id,
      managedId: managed?.id ?? null,
      managedExpiresAt: managed ? connectionExpiry(managed) : null,
      managedValid: managed ? managed.is_valid : null,
      source: null,
      expires_at: connectionExpiry(pick),
      expired: false,
      is_valid: pick.is_valid,
    })
  }
  return out
}

/** Local status merged with the workspace view of this user's connections (real mode only). */
export function mergeRemote(local: StatusResult, remote: RemoteProvider[], now = Date.now(), detections: Detection[] = []): StatusResult {
  const providers = local.providers.map((orig): ProviderStatus => {
    const r = remote.find((x) => x.integration_id === orig.id)
    const managedId = r ? (r.managedId !== undefined ? r.managedId : r.managed ? r.connection_id : null) : null
    // Saved to the workspace and no longer there: the credential is kept nowhere, so it cannot read as connected on its own.
    const gone = orig.sync === "synced" && orig.state !== "detected" && managedId == null
    // A credential still found on this machine is offered again, so it can be connected once more.
    const det = gone ? detections.find((d) => d.id === orig.id && d.source.kind !== "mcp-remote") : undefined
    const removed: Partial<ProviderStatus> = det
      ? { state: "detected", source: det.source, account: det.account, sync: "local", expiresAt: null, note: "The workspace connection was removed. Connect it again." }
      : { state: "not_found", source: null, account: null, sync: "local", expiresAt: null, note: REMOVED_NOTE }
    if (gone && r?.connection_id == null) return orderStatus({ ...orig, ...removed } as ProviderStatus)
    // Another connection of the caller's is still there: it is what the workspace shows for the provider.
    let p: ProviderStatus = gone ? ({ ...orig, ...removed, note: null } as ProviderStatus) : orig
    if (!r || r.connection_id == null) return p
    // A local rejected flag on a record kept in the workspace is stale once the workspace says otherwise: the workspace connection is what decides.
    if (p.state === "rejected") {
      if (orig.sync !== "synced") return p
      p = { ...p, state: "connected", note: null }
    }
    const remoteExpired = r.expired || isExpired(r.expires_at, now)
    // An expired copy is reported as expired; only a live one the workspace marked invalid counts as rejected.
    const remoteRejected = !remoteExpired && r.is_valid === false
    const rs = r.source?.label ? { kind: (r.source.kind as SourceKind) ?? "cli", label: r.source.label } : null
    if (p.state === "connected" || p.state === "expired") {
      // Only the connection this tool made holds this credential; a hand-made one says nothing about it.
      if (managedId == null) return p
      // A synced credential is held by the workspace, so once the workspace reports an expiry it replaces the older local value; with none reported, the local one stands.
      if (orig.sync === "synced") {
        // Expiry and validity come from the connection this tool made; the one shown may be a hand-made one.
        const mExpiresAt = r.managedExpiresAt !== undefined ? r.managedExpiresAt : r.expires_at
        const mValid = r.managedValid !== undefined ? r.managedValid : r.is_valid
        const mExpired = isExpired(mExpiresAt, now) || (r.managed && r.expired)
        const known = mExpiresAt != null || mExpired
        const expired = known ? mExpired : p.state === "expired"
        const rejectedNow = !expired && mValid === false
        return orderStatus({
          ...p,
          state: expired ? "expired" : rejectedNow ? "rejected" : "connected",
          expiresAt: mExpiresAt ?? p.expiresAt,
          note: expired ? "access expired, reconnect to continue" : rejectedNow ? REJECTED_NOTE : p.state === "connected" ? p.note : null,
        })
      }
      // A credential kept on this machine has its own expiry; the workspace only adds to it.
      const localFresh = p.state === "connected"
      const remoteKnown = r.expires_at != null
      const expired = !localFresh && (remoteExpired || !remoteKnown)
      const note = localFresh
        ? remoteExpired
          ? "workspace copy expired, reconnect to update it"
          : p.note
        : expired
          ? "access expired, reconnect to continue"
          : "local token expired, the workspace connection is still active"
      const rejected = !expired && remoteRejected
      return orderStatus({
        ...p,
        state: expired ? "expired" : rejected ? "rejected" : "connected",
        expiresAt: localFresh ? p.expiresAt : expired ? (p.expiresAt ?? r.expires_at) : r.expires_at,
        sync: p.sync === "blocked" ? p.sync : "synced",
        note: rejected ? REJECTED_NOTE : note,
      })
    }
    return orderStatus({
      ...p,
      state: remoteExpired ? "expired" : remoteRejected ? "rejected" : "connected",
      source: rs ?? { kind: "browser", label: "Altimate workspace" },
      account: r.account ?? p.account,
      syncable: true,
      sync: "synced",
      expiresAt: r.expires_at,
      note: remoteExpired ? "access expired, reconnect to continue" : remoteRejected ? REJECTED_NOTE : null,
      ...(managedId != null ? {} : { managed: false }),
      // A hand-made connection is shown, and what was found here stays offered next to it.
      ...(managedId == null && p.state === "detected" && p.source && p.sync !== "blocked" ? { found: { source: p.source, account: p.account } } : {}),
    })
  })
  return { ...local, providers }
}

export async function statusRemote(): Promise<StatusResult> {
  const local = status()
  const unchecked = (e: unknown): StatusResult => ({ ...local, workspace: workspaceInfo(), workspaceUnchecked: e instanceof Error ? e.message : String(e) })
  // An unreadable login is the same as an unreadable workspace: what is shown comes from this machine alone.
  let cfg: backend.BackendConfig | null
  try {
    cfg = await realConfig()
  } catch (e) {
    return unchecked(e)
  }
  if (!cfg) return local
  try {
    const remote = deriveRemote(await backend.listOwnConnections(cfg))
    const detections = Object.values(loadStore().providers).flatMap((rec) => (rec?.detection ? [rec.detection] : []))
    return { ...mergeRemote(local, remote, Date.now(), detections), workspace: await liveWorkspaceInfo() }
  } catch (e) {
    return { ...unchecked(e), workspace: await liveWorkspaceInfo().catch(() => workspaceInfo()) }
  }
}

// ---------------------------------------------------------------- policy

export function setBlocked(ids: ProviderId[], blocked: boolean): Promise<Store> {
  return updateStore((store) => {
    for (const id of ids) {
      if (blocked) store.blocked[id] = true
      else delete store.blocked[id]
    }
    return store
  })
}
/**
 * Blocks providers in one locked step with the uploads. One whose managed workspace copy exists
 * (recorded, or found by looking) is refused, since there is no local copy to keep. When the
 * workspace cannot be read the block is still set, as it only stops later uploads, and `unchecked` says so.
 */
export async function blockProviders(ids: ProviderId[]): Promise<{ blocked: ProviderId[]; refused: ProviderId[]; unchecked: ProviderId[] }> {
  return withLock(async () => {
    const refused: ProviderId[] = []
    const unchecked: ProviderId[] = []
    for (const id of ids) {
      if (isSynced(id)) {
        refused.push(id)
        continue
      }
      try {
        if (await managedInWorkspace(id)) refused.push(id)
      } catch {
        unchecked.push(id)
      }
    }
    const blocked = ids.filter((id) => !refused.includes(id))
    await setBlocked(blocked, true)
    return { blocked, refused, unchecked }
  })
}
export const isBlocked = (id: ProviderId) => Boolean(loadStore().blocked[id])
/** The credential was saved to the workspace by this tool: its secret is not kept on this machine, only the non-secret fields and status. */
export const isSynced = (id: ProviderId) => {
  const rec = loadStore().providers[id]
  return Boolean(rec?.registered && rec.synced)
}

/** This tool's workspace connection for the provider exists in the workspace. Throws when the workspace cannot be read, so a caller never mistakes a failed lookup for an absent connection. */
export async function managedInWorkspace(id: ProviderId): Promise<boolean> {
  const cfg = await realConfig()
  return cfg ? Boolean(findManaged(await backend.listOwnConnections(cfg), id)) : false
}

// ---------------------------------------------------------------- mock workspace sync

export interface SyncStep {
  label: string
  ok: boolean
}
export interface SyncOutcome {
  id: ProviderId
  result: "synced" | "kept_local" | "skipped" | "failed"
  reason?: string
  steps: SyncStep[]
  /** Attached to a workspace that is not private, so its members can use the connection. */
  shared?: true
  request?: { method: "POST"; path: "/connections"; body: { name: string; integration_id: string; config: Record<string, unknown> }; privacy: "private" }
}

/** Pure description of the request that would be sent. */
export function buildConnectionRequest(id: ProviderId, account: string | null, host = os.hostname()) {
  return {
    method: "POST" as const,
    path: "/connections" as const,
    privacy: "private" as const,
    body: {
      name: `${PROVIDER_NAMES[id]} (from ${host})`,
      integration_id: INTEGRATION_IDS[id],
      config: { account, credential: "<redacted>", privacy: "private" },
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ALREADY_IN_WORKSPACE = "already in the workspace"
const INVALID_IN_WORKSPACE = "the workspace connection is marked invalid; run update"

/** Attaches this tool's workspace connection for a provider that has nothing to upload from this machine; `fallback` is the outcome when there is none to attach. */
async function attachWithoutLocal(id: ProviderId, rec: StoredProvider | undefined, fallback: SyncOutcome, onStep: ((label: string, done: boolean) => void) | undefined, share: boolean): Promise<SyncOutcome> {
  const signedIn = await realConfig()
  if (!signedIn) return fallback
  try {
    if (!(await managedInWorkspace(id))) return fallback
  } catch (e) {
    return { id, result: "failed", reason: `Could not check your workspace for an existing connection: ${e instanceof Error ? e.message : String(e)}`, steps: [] }
  }
  return syncReal(id, signedIn, undefined, rec, null, onStep, true, share)
}

/** `skipSynced` leaves a connection this tool already saved to the workspace as it is (it is only attached to the linked workspace), for runs that cover every provider. `share` allows attaching to a workspace that is not private. */
export async function syncProvider(id: ProviderId, onStep?: (label: string, done: boolean) => void, pace = 0, skipSynced = false, share = false): Promise<SyncOutcome> {
  const store = loadStore()
  const rec = store.providers[id]
  // A sync before any detect still finds what is on this machine.
  const det = rec?.detection ?? (rec?.registered ? undefined : scan().find((d) => d.id === id))
  if (!rec?.registered && !det) {
    const nothing: SyncOutcome = { id, result: "skipped", reason: "nothing detected or connected", steps: [] }
    // A run over every provider still attaches a workspace connection this tool made, when nothing for the provider is on this machine.
    if (!skipSynced || store.blocked[id]) return nothing
    return attachWithoutLocal(id, rec, nothing, onStep, share)
  }
  if (store.blocked[id]) {
    // Blocked means the credential never leaves the machine; nothing is registered here without one.
    return { id, result: "kept_local", reason: "blocked by policy", steps: [] }
  }
  if (!rec?.registered && det && !det.syncable) {
    const notSyncable: SyncOutcome = { id, result: "skipped", reason: det.note ?? "not syncable", steps: [] }
    // What was found here cannot be uploaded, but a workspace connection this tool made is still attached by a run over every provider.
    return skipSynced ? attachWithoutLocal(id, rec, notSyncable, onStep, share) : notSyncable
  }
  const account = rec?.account ?? det?.account ?? null
  const cfg = await realConfig()
  const alreadySynced = skipSynced && Boolean(rec?.registered && rec.synced)
  if (cfg) {
    let attachOnly = alreadySynced
    // A run over every provider leaves a workspace connection this tool made as it is, even when this machine has no record of it.
    if (skipSynced && !attachOnly && !rec?.registered) {
      try {
        attachOnly = await managedInWorkspace(id)
      } catch (e) {
        return { id, result: "failed", reason: `Could not check your workspace for an existing connection: ${e instanceof Error ? e.message : String(e)}`, steps: [] }
      }
    }
    return syncReal(id, cfg, det, rec, account, onStep, attachOnly, share)
  }
  if (!mockMode()) return { id, result: "skipped", reason: NOT_SIGNED_IN, steps: [] }
  if (alreadySynced) return { id, result: "skipped", reason: "already in the workspace", steps: [] }
  const request = buildConnectionRequest(id, account)
  const steps: SyncStep[] = []
  for (const label of [
    "Validating credential",
    "Testing credential",
    `Upsert connection "${request.body.name}"`,
    "Enable on workspace",
  ]) {
    onStep?.(label, false)
    if (pace) await sleep(pace)
    steps.push({ label, ok: true })
    onStep?.(label, true)
  }
  // The block is read again under the lock that records the sync: one set while the steps ran stops it.
  const blockedMeanwhile = await withLock(async () => {
    if (loadStore().blocked[id]) return true
    const remote = readJson<Record<string, unknown>>(remotePath(), {})
    remote[id] = { ...request, enabled: true, workspace: workspaceInfo().name, recordedAt: new Date().toISOString() }
    writeJson(remotePath(), remote)
    await updateStore((next) => {
      const cur = next.providers[id] ?? {}
      next.providers[id] = { ...cur, registered: true, account, source: cur.source ?? det?.source, synced: true, updatedAt: new Date().toISOString() }
    })
    return false
  })
  if (blockedMeanwhile) return { id, result: "kept_local", reason: "blocked by policy", steps: [] }
  return { id, result: "synced", steps, request }
}

/** The backend wants the subdomain only: `https://acme.atlassian.net/` becomes `acme`. */
export function normaliseJiraDomain(value: string): string {
  return value
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.atlassian\.net(:\d+)?$/i, "")
}

/** Adds the variant key the backend needs to pick the Jira Server field set. Catalog fields only otherwise. */
export function withVariant(id: ProviderId, variant: string | undefined, config: Record<string, unknown>): Record<string, unknown> {
  return id === "jira" && isJiraServer(variant) ? { ...config, type: "server" } : config
}
/** The workspace catalog may name the Server / Data Center variant differently; any id naming "server" is it. */
export const isJiraServer = (variant: string | undefined) => /server/i.test(variant ?? "")

/** The connection config to upload for a provider: the saved credential when it was connected here, else what connect would read from this machine. Never printed. */
/** `saved` when the config is the credential saved here rather than one detected on this machine. */
export async function collectConfig(id: ProviderId, rec: StoredProvider | undefined): Promise<{ config: Record<string, unknown>; saved?: true } | { reason: string }> {
  if (rec?.registered && rec.variant) {
    const config: Record<string, unknown> = { ...rec.values }
    // Only a required secret has to be there; an optional one that was never filled in is simply left out.
    const fields = (await creds.loadCatalog(id, true)).find((v) => v.id === rec.variant)?.fields
    for (const field of rec.secretFields ?? []) {
      const value = await readSecret(secretKey("cred", id, field))
      if (!value) {
        if (fields?.find((f) => f.name === field)?.required === false) continue
        return { reason: "no local credential to upload" }
      }
      config[field] = value
    }
    return { config: withVariant(id, rec.variant, config), saved: true }
  }
  return creds.detectedConfig(id)
}

/** Whether the saved record is still the one a step started from: a connect, sync or disconnect in between changes it. */
export const sameRecord = (cur: StoredProvider | undefined, rec: StoredProvider | undefined) =>
  Boolean(cur?.registered) === Boolean(rec?.registered) &&
  Boolean(cur?.synced) === Boolean(rec?.synced) &&
  cur?.variant === rec?.variant &&
  (cur?.connectionId ?? null) === (rec?.connectionId ?? null) &&
  cur?.validatedAt === rec?.validatedAt &&
  cur?.credentialStamp === rec?.credentialStamp &&
  JSON.stringify(cur?.secretFields ?? []) === JSON.stringify(rec?.secretFields ?? []) &&
  JSON.stringify(Object.entries(cur?.values ?? {}).sort()) === JSON.stringify(Object.entries(rec?.values ?? {}).sort())

export interface UpsertResult {
  connectionId: number
  created: boolean
  isValid: boolean
  message: string | null
  /** What happened to the workspace attach; absent when the connection was saved invalid. */
  workspace?: { attached: string; workspaceId?: string; kept?: true; shared?: true } | { notLinked: true } | { error: string }
}

export const NOT_LINKED_LABEL = "Not linked to a workspace: run altimate link"
export const ATTACH_FAILED_PREFIX = "Saved the connection but could not attach it to the workspace: "

export const NOT_SIGNED_IN = "Not signed in to Altimate, kept local."

const INVALID_MESSAGE = "The workspace saved the connection but marked it invalid. Check the fields and run update."
const REFUSED_MESSAGE = "The workspace refused the connection as invalid. Check the fields and try again."
export const RECORD_WRITE_FAILED = (error: string, retry: string) =>
  `Saved to your workspace, but the record on this machine could not be written (${error}). ${retry} to update the same connection.`
export const LOCAL_CLEANUP_FAILED_PREFIX = "Saved to the workspace, but the local copy could not be removed: "
export const REMOVE_FAILED_WARNING = (error: string) => ` It could not be removed from the workspace, remove it there: ${error}`
/** What to tell the user when the workspace marked a connection invalid: a new one was removed again, an updated one is left marked. */
export const rejectionMessage = (res: Pick<UpsertResult, "created">) => (res.created ? REFUSED_MESSAGE : INVALID_MESSAGE)

/**
 * Saves the credential as this tool's own connection: updated in place when it exists (matched on
 * integration and name among the caller's own connections), created otherwise.
 */
export async function upsertManaged(cfg: backend.BackendConfig, id: ProviderId, config: Record<string, unknown>, share = false): Promise<UpsertResult> {
  const visible = await backend.listVisibleConnections(cfg)
  const existing = findManaged(backend.ownConnections(visible), id)
  const saved = existing
    ? await backend.updateConnection(cfg, existing.id, { config })
    : await backend.createConnection(cfg, { name: managedName(id), integration_id: INTEGRATION_IDS[id], config })
  const isValid = saved.is_valid !== false
  const result: UpsertResult = { connectionId: saved.id, created: !existing, isValid, message: isValid ? null : rejectionMessage({ created: !existing }) }
  if (!isValid) return result
  return { ...result, workspace: await attachToBoundWorkspace(cfg, id, saved.id, visible.map((c) => c.id), share) }
}

/** Attaches the connection to the workspace this directory is linked to, reporting instead of throwing. `share` allows a workspace that is not private. */
export async function attachToBoundWorkspace(cfg: backend.BackendConfig, id: ProviderId, connectionId: number, live?: (number | string)[], share = false): Promise<NonNullable<UpsertResult["workspace"]>> {
  try {
    const outcome = await resolveBindingOutcome(process.cwd())
    if (outcome.status === "unbound") return { notLinked: true }
    // A link remembered from earlier may have been moved since: nothing is written to a workspace that cannot be confirmed.
    if (outcome.status === "unknown" || (outcome.status === "bound" && outcome.stale)) {
      // Without an Altimate login (only the integrations backend variables are set) there is nothing to look a link up with.
      if (!(await AltimateApi.isConfigured())) return { notLinked: true }
      return { error: `${outcome.status === "unknown" ? "could not tell whether this directory is linked to a workspace" : "could not confirm which workspace this directory is linked to"}, so the connection was not attached to one` }
    }
    const binding = outcome.binding
    const { kept, shared } = await attachToWorkspace(cfg, id, connectionId, String(binding.datamateId), live, share)
    return { attached: binding.datamateName, workspaceId: String(binding.datamateId), ...(kept ? { kept: true as const } : {}), ...(shared ? { shared: true as const } : {}) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

const READ_ONLY_TOOL = /(^|_)(get|list|search)_/

/**
 * The workspace's integrations list with the connection attached to the provider's entry. An
 * existing entry keeps its tools and any other primary connection; a new one enables only the read-only tools. Other entries pass
 * through untouched.
 */
export function attachToIntegrations(
  entries: backend.DatamateIntegrationEntry[],
  providerIntegrationId: string,
  connectionId: number | string,
  catalogToolKeys: string[],
  liveConnectionIds?: (number | string)[],
): backend.DatamateIntegrationEntry[] {
  const live = liveConnectionIds && new Set(liveConnectionIds.map(String))
  const conn = String(connectionId)
  if (!entries.some((e) => String(e.id) === providerIntegrationId)) {
    return [...entries, { id: providerIntegrationId, tools: catalogToolKeys.filter((k) => READ_ONLY_TOOL.test(k)).map((key) => ({ key })), connection_id: conn }]
  }
  return entries.map((e) => {
    if (String(e.id) !== providerIntegrationId) return e
    // An entry already wired to another live connection keeps it; only an empty one, a deleted one, or one on this connection is set.
    const stale = live && e.connection_id != null && !live.has(String(e.connection_id))
    const next = e.connection_id == null || stale || String(e.connection_id) === conn ? { ...e, connection_id: conn } : { ...e }
    if (Array.isArray(e.connection_ids)) {
      const kept = stale ? e.connection_ids.filter((c) => String(c) !== String(e.connection_id)) : e.connection_ids
      next.connection_ids = kept.map(String).includes(conn) ? kept : [...kept, conn]
    }
    return next
  })
}

export const SHARED_WORKSPACE_REFUSAL = (name: string, id: ProviderId) =>
  `workspace "${name}" is shared, so attaching would let its members use this connection; it stays saved to your account only. Run altimate integrations sync ${id} --share to attach it`

/** `kept` when the workspace's entry kept a different live connection instead of taking this one; `shared` when the workspace is not private. */
async function attachToWorkspace(cfg: backend.BackendConfig, id: ProviderId, connectionId: number, datamateId: string, liveIds: (number | string)[] | undefined, share: boolean): Promise<{ kept: boolean; shared: boolean }> {
  const integrationId = INTEGRATION_IDS[id]
  const first = await backend.getDatamate(cfg, datamateId)
  if (first.is_owner === false)
    throw new Error(`only the owner of workspace "${first.name}" can attach connections to it; your connection is saved to your account. Link a workspace you own, or sign in as its owner`)
  // Attaching widens the connection to the workspace's audience, so only a workspace that says it is private takes it unasked.
  // A connection the workspace already uses was shared before; keeping it attached widens nothing.
  const conn = String(connectionId)
  const allowed = (d: backend.DatamateRecord) => {
    const shared = d.privacy !== "private"
    const attached = d.integrations.some(
      (e) => String(e.id) === integrationId && (String(e.connection_id ?? "") === conn || (Array.isArray(e.connection_ids) && e.connection_ids.map(String).includes(conn))),
    )
    if (shared && !share && !attached) throw new Error(SHARED_WORKSPACE_REFUSAL(d.name, id))
    return shared
  }
  allowed(first)
  let keys: string[] = []
  if (!first.integrations.some((e) => String(e.id) === integrationId)) {
    const catalog = await backend.integrationsCatalog(cfg)
    const list: any[] = backend.catalogEntries(catalog)
    const found = list.find((c) => String(c?.id) === integrationId)
    if (!found) throw new Error(`the workspace catalog has no entry for ${PROVIDER_NAMES[id]}, so the connection was not attached to workspace "${first.name}"`)
    keys = (found.tools ?? []).map((t: any) => t?.key).filter((k: unknown): k is string => typeof k === "string")
  }
  // The backend replaces the whole list, so it is read again right before writing and only this entry changes. Its privacy is checked again: it may have changed since.
  const datamate = await backend.getDatamate(cfg, datamateId)
  const shared = allowed(datamate)
  const live = liveIds ?? (await backend.listVisibleConnections(cfg)).map((c) => c.id)
  const next = attachToIntegrations(datamate.integrations, integrationId, connectionId, keys, live)
  await backend.updateDatamateIntegrations(cfg, datamateId, next)
  const entry = next.find((e) => String(e.id) === integrationId)
  const usesThis = String(entry?.connection_id ?? "") === conn || (Array.isArray(entry?.connection_ids) && entry.connection_ids.map(String).includes(conn))
  // Members can use this connection only when the entry now names it; a kept entry on another connection widens nothing.
  return { kept: entry?.connection_id != null && String(entry.connection_id) !== conn, shared: shared && usesThis }
}

/** The integrations list without references to the connection; other entries pass through untouched. */
export function detachFromIntegrations(entries: backend.DatamateIntegrationEntry[], connectionId: number | string): backend.DatamateIntegrationEntry[] {
  const conn = String(connectionId)
  return entries.map((e) => {
    const next = { ...e }
    if (e.connection_id != null && String(e.connection_id) === conn) next.connection_id = null
    if (Array.isArray(e.connection_ids)) next.connection_ids = e.connection_ids.filter((c) => String(c) !== conn)
    return next
  })
}

/** Removes the connection from the linked workspace's integrations before it is deleted. Returns why it could not, or null; the delete goes on either way. */
async function detachFromBoundWorkspace(cfg: backend.BackendConfig, connectionId: number): Promise<string | null> {
  try {
    const outcome = await resolveBindingOutcome(process.cwd())
    if (outcome.status === "unbound") return null
    if (outcome.status === "unknown") return "could not tell whether this directory is linked to a workspace, so the connection was not detached from one"
    if (outcome.stale) return "could not confirm which workspace this directory is linked to, so the connection was not detached from one"
    const binding = outcome.binding
    const datamateId = String(binding.datamateId)
    const datamate = await backend.getDatamate(cfg, datamateId)
    if (datamate.is_owner === false) return `only the owner of workspace "${datamate.name}" can detach connections from it`
    const refs = (e: backend.DatamateIntegrationEntry) => String(e.connection_id) === String(connectionId) || (e.connection_ids ?? []).map(String).includes(String(connectionId))
    if (!datamate.integrations.some(refs)) return null
    await backend.updateDatamateIntegrations(cfg, datamateId, detachFromIntegrations(datamate.integrations, connectionId))
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

async function syncReal(
  id: ProviderId,
  cfg: backend.BackendConfig,
  det: Detection | undefined,
  rec: StoredProvider | undefined,
  account: string | null,
  onStep?: (label: string, done: boolean) => void,
  attachOnly = false,
  share = false,
): Promise<SyncOutcome> {
  // A keychain that cannot be read fails this provider only; it is not taken as having nothing to upload.
  const collected = attachOnly
    ? { reason: ALREADY_IN_WORKSPACE }
    : await collectConfig(id, rec).catch((e: unknown) => ({ unreadable: e instanceof Error ? e.message : String(e) }))
  if ("unreadable" in collected) return { id, result: "failed", reason: collected.unreadable, steps: [] }
  const steps: SyncStep[] = []
  const step = (l: string) => {
    steps.push({ label: l, ok: true })
    onStep?.(l, true)
  }
  const reportWorkspace = (w: NonNullable<UpsertResult["workspace"]>): SyncOutcome => {
    if ("error" in w) return { id, result: "failed", reason: ATTACH_FAILED_PREFIX + w.error, steps }
    if ("attached" in w) step(w.kept ? `Kept the workspace's existing connection in ${workspaceLabel(w.attached, w.workspaceId)}` : `Attached to ${workspaceLabel(w.attached, w.workspaceId)}`)
    else {
      steps.push({ label: NOT_LINKED_LABEL, ok: false })
      onStep?.(NOT_LINKED_LABEL, false)
    }
    return { id, result: "synced", steps, ...("attached" in w && w.shared ? { shared: true as const } : {}) }
  }
  if ("reason" in collected) {
    // Nothing local to upload, but a connection already in the workspace may still need attaching to it: the one this machine saved, or one it has no record of.
    const knownFor = (r: StoredProvider | undefined) =>
      r?.registered ? (r.synced && r.connectionId ? r.connectionId : undefined) : collected.reason === ALREADY_IN_WORKSPACE ? null : undefined
    if (knownFor(rec) === undefined) return { id, result: "skipped", reason: collected.reason, steps: [] }
    try {
      // The record, the blocked flag and the workspace's connections are all read under the lock that the attach runs in.
      return await withLock(async (): Promise<SyncOutcome> => {
        const store = loadStore()
        if (store.blocked[id]) return { id, result: "kept_local", reason: "blocked by policy", steps: [] }
        const known = knownFor(store.providers[id])
        if (known === undefined) return { id, result: "skipped", reason: collected.reason, steps: [] }
        const visible = await backend.listVisibleConnections(cfg)
        const own = backend.ownConnections(visible)
        // The workspace decides whether the connection is usable, not the flag kept here from an earlier check.
        const found = known == null ? findManaged(own, id) : own.find((c) => c.id === known && c.integration_id === INTEGRATION_IDS[id])
        // A connection this machine saved that is gone from the workspace is not attached; it was deleted there.
        if (!found) return { id, result: "skipped", reason: known == null ? collected.reason : REMOVED_NOTE, steps: [] }
        if (found.is_valid === false) return { id, result: "skipped", reason: INVALID_IN_WORKSPACE, steps: [] }
        step("Connection already in the workspace")
        return reportWorkspace(await attachToBoundWorkspace(cfg, id, found.id, visible.map((c) => c.id), share))
      })
    } catch (e) {
      return { id, result: "failed", reason: e instanceof Error ? e.message : String(e), steps }
    }
  }
  // The provider accepts the credential before anything is uploaded, as connect checks it; a refused or unreachable provider uploads nothing.
  const check = await creds.validate(id, collected.config.type === "server" ? "server" : "", collected.config as Record<string, string>)
  if (!check.ok) {
    // As connect does: a provider refusing the credential saved on this machine marks that record rejected; a detected one is not stored, so nothing is marked.
    if (check.rejected && rec?.registered && rec.variant && rec.secretFields?.length) {
      await updateStore((next) => {
        // The check ran outside the lock: a record that was replaced since is not the credential that was refused.
        if (sameRecord(next.providers[id], rec)) next.providers[id] = { ...next.providers[id], rejected: true, validatedAt: new Date().toISOString() }
      })
    }
    return { id, result: "failed", reason: check.message ?? "Could not validate the credentials", steps }
  }
  // A known expiry carries over only for the saved credential; a detected token may have been replaced since it was recorded.
  const expiresAt = check.expiresAt ?? (collected.saved ? rec?.expiresAt : null) ?? null
  const upload = expiresAt ? { ...collected.config, expires_at: expiresAt } : collected.config
  try {
    // The blocked check, the record check and the upload share one lock with Keep local and Disconnect. The config was prepared before the lock, so the record is compared again here.
    return await withLock(async (): Promise<SyncOutcome> => {
      const now = loadStore()
      if (now.blocked[id]) return { id, result: "kept_local", reason: "blocked by policy", steps: [] }
      const cur = now.providers[id]
      if (!sameRecord(cur, rec))
        return { id, result: "failed", reason: "the connection changed while syncing, run sync again", steps: [] }
      const res = await upsertManaged(cfg, id, upload, share)
      if (!res.isValid) {
        // A workspace that refuses a new connection keeps nothing of it; the local copy stays.
        let warning = ""
        if (res.created) {
          try {
            await backend.deleteConnection(cfg, res.connectionId)
          } catch (e) {
            warning = REMOVE_FAILED_WARNING(e instanceof Error ? e.message : String(e))
          }
        }
        return { id, result: "failed", reason: rejectionMessage(res) + warning, steps }
      }
      step(res.created ? "Created connection" : "Updated connection")
      try {
        await updateStore((next) => {
          next.providers[id] = {
            ...next.providers[id],
            registered: true,
            account: check.account ?? account,
            validatedAt: new Date().toISOString(),
            source: next.providers[id]?.source ?? det?.source,
            synced: true,
            rejected: false,
            unverified: false,
            connectionId: res.connectionId,
            expiresAt,
            updatedAt: new Date().toISOString(),
          }
        })
      } catch (e) {
        return { id, result: "failed", reason: RECORD_WRITE_FAILED(e instanceof Error ? e.message : String(e), "Run sync again"), steps }
      }
      // The connection is in the workspace and accepted: no secret stays on this machine, the same as when it is connected there directly.
      try {
        await purgeCredentialSecrets(id, rec, false)
        await deleteSecret(id)
      } catch (e) {
        // The workspace holds the connection and the record says so; only the local cleanup is left to redo, which running sync for this provider does.
        steps.push({ label: `${LOCAL_CLEANUP_FAILED_PREFIX}${e instanceof Error ? e.message : String(e)}. Run altimate integrations sync ${id} to remove it.`, ok: false })
      }
      return reportWorkspace(res.workspace ?? { notLinked: true })
    })
  } catch (e) {
    return { id, result: "failed", reason: e instanceof Error ? e.message : String(e), steps }
  }
}

export interface DisconnectResult {
  removedLocal: boolean
  removedRemote: number
  /** False when a connection could not be taken out of the linked workspace's list before it was deleted. */
  detached: boolean
  detachMessage?: string
  /** Set when the login could not be read, so the workspace was not checked for copies of this connection. */
  workspaceUnchecked?: string
}

/** Removes the workspace copies first and the local credential only once that worked, so a failure can be retried. */
export function disconnect(id: ProviderId): Promise<DisconnectResult> {
  // One locked step, so an upload cannot land between the workspace delete and the local purge.
  return withLock(async () => {
    // An unreadable login only matters for a credential saved in the workspace; a local one is removed without it.
    const synced = isSynced(id)
    let workspaceUnchecked: string | undefined
    const login = await realConfig().catch((e) => {
      if (synced) throw e
      workspaceUnchecked = e instanceof Error ? e.message : String(e)
      return null
    })
    if (synced && !login && !mockMode())
      throw new Error(`${PROVIDER_NAMES[id]} is saved in your workspace. Sign in to Altimate to remove it, then disconnect again.`)
    const { removed, detachError } = await removeManaged(id, login)
    const removedLocal = await disconnectLocal(id)
    await creds.discardDraftSecrets(id)
    return { removedLocal, removedRemote: removed, detached: detachError == null, ...(detachError ? { detachMessage: detachError } : {}), ...(workspaceUnchecked ? { workspaceUnchecked } : {}) }
  })
}

function disconnectLocal(id: ProviderId): Promise<boolean> {
  return withLock(async () => {
    const rec = loadStore().providers[id]
    const had = Boolean(rec?.registered)
    // Secrets go first: if the keychain refuses, the record still says what is stored, so a retry can finish.
    await deleteSecret(id)
    await purgeCredentialSecrets(id, rec)
    const store = loadStore()
    const cur = store.providers[id]
    if (cur) store.providers[id] = { detection: cur.detection, updatedAt: new Date().toISOString() }
    saveStore(store)
    return (await removeMockRemote(id)) || had
  })
}

/** Removes the recorded stand-in for the workspace copy that mock and demo modes keep in a local file. */
export function removeMockRemote(id: ProviderId): Promise<boolean> {
  return withLock(() => {
    const remote = readJson<Record<string, unknown>>(remotePath(), {})
    if (!(id in remote)) return false
    delete remote[id]
    writeJson(remotePath(), remote)
    return true
  })
}

/**
 * Removes the provider's connections that this tool made in the workspace (named after this
 * machine), so a disconnect does not leave a copy behind. Connections made by hand in the web app
 * are left alone. Returns how many went.
 */
export async function disconnectRemote(id: ProviderId, cfg?: backend.BackendConfig | null): Promise<number> {
  return (await removeManaged(id, cfg === undefined ? await realConfig() : cfg)).removed
}

/** Like disconnectRemote, and also says why a connection could not be detached from the linked workspace. The workspace list is replaced whole, so a failed detach leaves a dangling reference. */
export async function removeManaged(id: ProviderId, config: backend.BackendConfig | null): Promise<{ removed: number; detachError: string | null }> {
  if (!config) return { removed: 0, detachError: null }
  const name = managedName(id)
  const managed = (await backend.listOwnConnections(config)).filter((c) => c.integration_id === INTEGRATION_IDS[id] && c.name === name)
  let detachError: string | null = null
  for (const c of managed) {
    detachError = (await detachFromBoundWorkspace(config, c.id)) ?? detachError
    await backend.deleteConnection(config, c.id)
  }
  return { removed: managed.length, detachError }
}

export * as IntegrationsCore from "./core"
