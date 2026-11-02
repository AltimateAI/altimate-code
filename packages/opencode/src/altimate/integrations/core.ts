// altimate_change - new file
//
// One-click local integrations: detection of existing credentials, local storage and the sync of a
// credential to the caller's own workspace connection. Offline (mock or demo) the workspace side is
// simulated: nothing is sent anywhere, the request that would be made is recorded in a local file.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { Global } from "../../global"
import * as backend from "./backend"
import { resolveBinding } from "../workspace/state"

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
}

export interface StatusResult {
  workspace: { name: string; tenant: string }
  providers: ProviderStatus[]
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
  /** The last validation was refused by the provider. */
  rejected?: boolean
}
export interface Store {
  blocked: Partial<Record<ProviderId, boolean>>
  providers: Partial<Record<ProviderId, StoredProvider>>
}

const REJECTED_NOTE = "Token rejected, update it"
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
export function writeJson(file: string, value: unknown, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode })
  if (mode) fs.chmodSync(file, mode)
}

export function loadStore(): Store {
  const raw = readJson<Partial<Store>>(statePath(), {})
  return { blocked: raw.blocked ?? {}, providers: raw.providers ?? {} }
}
export function saveStore(store: Store) {
  writeJson(statePath(), store)
}

// ---------------------------------------------------------------- secrets

export function maskSecret(secret: string): string {
  return secret.length <= 8 ? "••••" : `${secret.slice(0, secret.indexOf("_") > 0 ? secret.indexOf("_") + 1 : 3)}••••${secret.slice(-4)}`
}

/** Secret-store account for a credential field; the draft and the connected copy are kept apart. */
export const secretKey = (kind: "draft" | "cred", id: ProviderId, field: string) => `${kind}:${id}:${field}`
/** The fields a provider is known to hold as secrets, before the workspace catalog is read. */
export const BUILTIN_SECRET_FIELDS: Record<ProviderId, string[]> = {
  github: ["github_token"],
  jira: ["jiraApiToken", "jiraPatToken"],
  linear: ["linearApiKey"],
}

export function storeSecret(id: string, secret: string) {
  if (useKeychain()) {
    const r = spawnSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", id, "-w", secret], {
      stdio: "ignore",
    })
    if (r.status === 0) return
  }
  const all = readJson<Record<string, string>>(secretsPath(), {})
  all[id] = secret
  writeJson(secretsPath(), all, 0o600)
}
export function readSecret(id: string): string | undefined {
  if (useKeychain()) {
    const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (r.status === 0) return r.stdout.trim()
  }
  return readJson<Record<string, string>>(secretsPath(), {})[id]
}
export function deleteSecret(id: string) {
  if (useKeychain()) spawnSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id], { stdio: "ignore" })
  const all = readJson<Record<string, string>>(secretsPath(), {})
  if (id in all) {
    delete all[id]
    writeJson(secretsPath(), all, 0o600)
  }
}
/** Removes every draft and connected secret kept for a provider's credential form. */
export function purgeCredentialSecrets(id: ProviderId, rec?: StoredProvider) {
  for (const field of new Set([...BUILTIN_SECRET_FIELDS[id], ...(rec?.secretFields ?? [])])) {
    deleteSecret(secretKey("draft", id, field))
    deleteSecret(secretKey("cred", id, field))
  }
}

/** Claude MCP server maps that apply here: user level, this project, and the project `.mcp.json`. */
export function mcpServerMaps(home: string, cwd: string): Record<string, McpServer>[] {
  const claude = readJson<any>(path.join(home, ".claude.json"), {})
  const maps: Record<string, McpServer>[] = [claude.mcpServers ?? {}, claude.projects?.[cwd]?.mcpServers ?? {}]
  maps.push(readJson<any>(path.join(cwd, ".mcp.json"), {}).mcpServers ?? {})
  return maps
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

/** Detections from parsed Claude MCP server maps. Pure: reads nothing from disk. */
export function detectFromMcpServers(servers: Record<string, McpServer>, origin: string): Detection[] {
  const found: Detection[] = []
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!server || typeof server !== "object") continue
    const haystack = [name, server.command, server.url, ...(server.args ?? [])].filter(Boolean).join(" ")
    for (const id of PROVIDER_IDS) {
      if (!MCP_MATCHERS[id].test(haystack)) continue
      const remote = Boolean(server.url) || server.type === "http" || server.type === "sse"
      const hasToken = Object.values(server.env ?? {}).some((v) => typeof v === "string" && v.length > 0)
      if (remote) {
        found.push({
          id,
          source: { kind: "mcp-remote", label: `Claude MCP (${name})` },
          account: null,
          syncable: false,
          note: "usable in Claude; connect in browser to sync",
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
    out.push(...detectFromMcpServers(project.mcpServers ?? {}, ".mcp.json"))
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
    { id: "github", source: { kind: "cli", label: "gh CLI" }, account: "harish-altimate", syncable: true, note: null },
    { id: "jira", source: { kind: "cli", label: "jira-cli" }, account: "harish@altimate.ai", syncable: true, note: "site https://altimate.atlassian.net" },
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

export function recordDetections(found: Detection[]): Store {
  const store = loadStore()
  for (const id of PROVIDER_IDS) {
    const d = found.find((f) => f.id === id)
    const prev = store.providers[id] ?? {}
    if (d) store.providers[id] = { ...prev, detection: d, updatedAt: new Date().toISOString() }
    else if (!prev.registered && !prev.drafts) delete store.providers[id]
    else store.providers[id] = { ...prev, detection: undefined }
  }
  saveStore(store)
  return store
}

// ---------------------------------------------------------------- status

export function workspaceInfo() {
  return { name: "Altimate Demo", tenant: "altimate" }
}

/** The workspace being talked to: the real tenant and, when this directory is linked, the linked workspace's name. */
export async function liveWorkspaceInfo(): Promise<{ name: string; tenant: string }> {
  const cfg = await realConfig()
  if (!cfg) return workspaceInfo()
  const binding = await resolveBinding(process.cwd()).catch(() => null)
  return { name: binding?.datamateName || cfg.tenant, tenant: cfg.tenant }
}

function orderStatus(p: ProviderStatus): ProviderStatus {
  return { id: p.id, name: p.name, state: p.state, source: p.source, account: p.account, syncable: p.syncable, sync: p.sync, updatedAt: p.updatedAt, expiresAt: p.expiresAt, note: p.note }
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
        note: rejected ? REJECTED_NOTE : blocked ? "kept local by policy" : expired ? "access expired, reconnect to continue" : null,
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
  /** True for the connection this tool made (named after this machine). */
  managed: boolean
  source: { kind?: string; label?: string } | null
  expires_at: string | null
  expired: boolean
  is_valid: boolean | null
}

/** The name this tool gives its connection for a provider on this machine. */
export const managedName = (id: ProviderId, host = os.hostname()) => `${PROVIDER_NAMES[id]} (from ${host})`

const validatedAt = (c: backend.Connection) => Date.parse(c.last_validated_at ?? "") || 0

/** The connection this tool manages for a provider: matched on integration and name. */
export function findManaged(connections: backend.Connection[], id: ProviderId, host = os.hostname()): backend.Connection | undefined {
  const name = managedName(id, host)
  return connections.filter((c) => c.integration_id === INTEGRATION_IDS[id] && c.name === name).sort((a, b) => b.id - a.id)[0]
}

/**
 * The remote state of each provider from the caller's own connections: the managed one when there is
 * one, else the most recently validated one.
 */
export function deriveRemote(connections: backend.Connection[], host = os.hostname()): RemoteProvider[] {
  const out: RemoteProvider[] = []
  for (const id of PROVIDER_IDS) {
    const own = connections.filter((c) => c.integration_id === INTEGRATION_IDS[id])
    const managed = findManaged(connections, id, host)
    const pick = managed ?? own.sort((a, b) => validatedAt(b) - validatedAt(a) || b.id - a.id)[0]
    if (!pick) continue
    out.push({ integration_id: id, connection_id: pick.id, name: pick.name, account: null, managed: Boolean(managed), source: null, expires_at: null, expired: false, is_valid: pick.is_valid })
  }
  return out
}

/** Local status merged with the workspace view of this user's connections (real mode only). */
export function mergeRemote(local: StatusResult, remote: RemoteProvider[], now = Date.now()): StatusResult {
  const providers = local.providers.map((p): ProviderStatus => {
    const r = remote.find((x) => x.integration_id === p.id)
    if (!r || r.connection_id == null || p.state === "rejected") return p
    const remoteExpired = r.expired || isExpired(r.expires_at, now)
    // An expired copy is reported as expired; only a live one the workspace marked invalid counts as rejected.
    const remoteRejected = !remoteExpired && r.is_valid === false
    const rs = r.source?.label ? { kind: (r.source.kind as SourceKind) ?? "cli", label: r.source.label } : null
    if (p.state === "connected" || p.state === "expired") {
      // A fresh local token or connection wins; the workspace copy is only reported in the note.
      const localFresh = p.state === "connected"
      const expired = !localFresh && remoteExpired
      const note = localFresh
        ? remoteExpired
          ? "workspace copy expired, reconnect to update it"
          : p.note
        : expired
          ? "access expired, reconnect to continue"
          : "local token expired, the workspace connection is still active"
      return orderStatus({
        ...p,
        state: expired ? "expired" : localFresh && remoteRejected ? "rejected" : "connected",
        expiresAt: localFresh ? p.expiresAt : expired ? (p.expiresAt ?? r.expires_at) : r.expires_at,
        sync: p.sync === "blocked" || !r.managed ? p.sync : "synced",
        note: localFresh && remoteRejected ? REJECTED_NOTE : note,
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
    })
  })
  return { ...local, providers }
}

export async function statusRemote(): Promise<StatusResult> {
  const local = status()
  const cfg = await realConfig()
  if (!cfg) return local
  try {
    const remote = deriveRemote(await backend.listOwnConnections(cfg))
    return { ...mergeRemote(local, remote), workspace: await liveWorkspaceInfo() }
  } catch {
    return local
  }
}

// ---------------------------------------------------------------- policy

export function setBlocked(ids: ProviderId[], blocked: boolean): Store {
  const store = loadStore()
  for (const id of ids) {
    if (blocked) store.blocked[id] = true
    else delete store.blocked[id]
  }
  saveStore(store)
  return store
}
export const isBlocked = (id: ProviderId) => Boolean(loadStore().blocked[id])

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

export async function syncProvider(id: ProviderId, onStep?: (label: string, done: boolean) => void, pace = 0): Promise<SyncOutcome> {
  const store = loadStore()
  const rec = store.providers[id]
  // A sync before any detect still finds what is on this machine.
  const det = rec?.detection ?? (rec?.registered ? undefined : scan().find((d) => d.id === id))
  if (!rec?.registered && !det) return { id, result: "skipped", reason: "nothing detected or connected", steps: [] }
  if (store.blocked[id]) {
    // Blocked means the credential is still registered for local use; it just never leaves the machine.
    if (!rec?.registered && det?.syncable) {
      store.providers[id] = { ...rec, detection: det, registered: true, account: det.account, source: det.source, synced: false, updatedAt: new Date().toISOString() }
      saveStore(store)
    }
    return { id, result: "kept_local", reason: "blocked by policy", steps: [] }
  }
  if (!rec?.registered && det && !det.syncable) return { id, result: "skipped", reason: det.note ?? "not syncable", steps: [] }
  const account = rec?.account ?? det?.account ?? null
  const cfg = await realConfig()
  if (cfg) return syncReal(id, cfg, det, rec, account, onStep)
  const request = buildConnectionRequest(id, account)
  const steps: SyncStep[] = []
  for (const label of [
    "Validating credential",
    "POST /connections/test",
    `Upsert connection "${request.body.name}"`,
    "Enable on workspace",
  ]) {
    onStep?.(label, false)
    if (pace) await sleep(pace)
    steps.push({ label, ok: true })
    onStep?.(label, true)
  }
  const remote = readJson<Record<string, unknown>>(remotePath(), {})
  remote[id] = { ...request, enabled: true, workspace: workspaceInfo().name, recordedAt: new Date().toISOString() }
  writeJson(remotePath(), remote)
  const next = loadStore()
  const cur = next.providers[id] ?? {}
  next.providers[id] = {
    ...cur,
    registered: true,
    account,
    source: cur.source ?? det?.source,
    synced: true,
    updatedAt: new Date().toISOString(),
  }
  saveStore(next)
  return { id, result: "synced", steps, request }
}

/** The backend wants the subdomain only: `https://acme.atlassian.net/` becomes `acme`. */
export function normaliseJiraDomain(value: string): string {
  return value
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.atlassian\.net$/i, "")
}

function jiraDomain(det: Detection | undefined): string | undefined {
  if (process.env.JIRA_DOMAIN) return normaliseJiraDomain(process.env.JIRA_DOMAIN)
  const site = det?.note?.match(/^site (\S+)/)?.[1]
  if (!site) return undefined
  try {
    return new URL(site).host.replace(/\.atlassian\.net$/, "")
  } catch {
    return site
  }
}

/** Adds the variant key the backend needs to pick the Jira Server field set. Catalog fields only otherwise. */
export function withVariant(id: ProviderId, variant: string | undefined, config: Record<string, unknown>): Record<string, unknown> {
  return id === "jira" && variant === "server" ? { ...config, type: "server" } : config
}

/** The connection config to upload for a provider, read from where it was detected. Never printed. */
export function collectConfig(id: ProviderId, det: Detection | undefined, rec: StoredProvider | undefined): { config: Record<string, unknown> } | { reason: string } {
  if (rec?.registered && rec.variant) {
    const config: Record<string, unknown> = { ...rec.values }
    for (const field of rec.secretFields ?? []) {
      const value = readSecret(secretKey("cred", id, field))
      if (!value) return { reason: "no local credential to upload" }
      config[field] = value
    }
    return { config: withVariant(id, rec.variant, config) }
  }
  if (!det) return { reason: "nothing detected" }
  if (id === "github") {
    let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (det.source.kind === "cli") {
      const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
      if (r.status === 0 && r.stdout.trim()) token = r.stdout.trim()
    }
    return token ? { config: { github_token: token } } : { reason: "could not read the GitHub token" }
  }
  if (id === "linear") {
    const key = process.env.LINEAR_API_KEY
    return key ? { config: { linearApiKey: key } } : { reason: "set LINEAR_API_KEY to sync Linear" }
  }
  const token = process.env.JIRA_API_TOKEN
  const email = process.env.JIRA_USER || det.account
  const domain = jiraDomain(det)
  if (!token || !email || !domain) return { reason: "set JIRA_API_TOKEN (and JIRA_USER) to sync Jira" }
  return { config: { jiraApiToken: token, jiraEmail: email, jiraDomain: domain } }
}

export interface UpsertResult {
  connectionId: number
  created: boolean
  isValid: boolean
  message: string | null
  /** What happened to the workspace attach; absent when the connection was saved invalid. */
  workspace?: { attached: string } | { notLinked: true } | { error: string }
}

export const NOT_LINKED_LABEL = "Not linked to a workspace: run altimate link"
export const ATTACH_FAILED_PREFIX = "Saved the connection but could not attach it to the workspace: "

const INVALID_MESSAGE = "The workspace saved the connection but marked it invalid. Check the fields and run update."

/**
 * Saves the credential as this tool's own connection: updated in place when it exists (matched on
 * integration and name among the caller's own connections), created otherwise.
 */
export async function upsertManaged(cfg: backend.BackendConfig, id: ProviderId, config: Record<string, unknown>): Promise<UpsertResult> {
  const existing = findManaged(await backend.listOwnConnections(cfg), id)
  const saved = existing
    ? await backend.updateConnection(cfg, existing.id, { config })
    : await backend.createConnection(cfg, { name: managedName(id), integration_id: INTEGRATION_IDS[id], config })
  const isValid = saved.is_valid !== false
  const result: UpsertResult = { connectionId: saved.id, created: !existing, isValid, message: isValid ? null : INVALID_MESSAGE }
  if (!isValid) return result
  return { ...result, workspace: await attachToBoundWorkspace(cfg, id, saved.id) }
}

/** Attaches the connection to the workspace this directory is linked to, reporting instead of throwing. */
export async function attachToBoundWorkspace(cfg: backend.BackendConfig, id: ProviderId, connectionId: number): Promise<NonNullable<UpsertResult["workspace"]>> {
  const binding = await resolveBinding(process.cwd()).catch(() => null)
  if (!binding) return { notLinked: true }
  try {
    await attachToWorkspace(cfg, id, connectionId, String(binding.datamateId))
    return { attached: binding.datamateName }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

const READ_ONLY_TOOL = /(^|_)(get|list|search)_/

/**
 * The workspace's integrations list with the connection attached to the provider's entry. An
 * existing entry keeps its tools; a new one enables only the read-only tools. Other entries pass
 * through untouched.
 */
export function attachToIntegrations(
  entries: backend.DatamateIntegrationEntry[],
  providerIntegrationId: string,
  connectionId: number | string,
  catalogToolKeys: string[],
): backend.DatamateIntegrationEntry[] {
  const conn = String(connectionId)
  if (!entries.some((e) => String(e.id) === providerIntegrationId)) {
    return [...entries, { id: providerIntegrationId, tools: catalogToolKeys.filter((k) => READ_ONLY_TOOL.test(k)).map((key) => ({ key })), connection_id: conn }]
  }
  return entries.map((e) => {
    if (String(e.id) !== providerIntegrationId) return e
    const next = { ...e, connection_id: conn }
    if (Array.isArray(e.connection_ids) && !e.connection_ids.map(String).includes(conn)) next.connection_ids = [...e.connection_ids, conn]
    return next
  })
}

async function attachToWorkspace(cfg: backend.BackendConfig, id: ProviderId, connectionId: number, datamateId: string): Promise<void> {
  const integrationId = INTEGRATION_IDS[id]
  const datamate = await backend.getDatamate(cfg, datamateId)
  if (datamate.is_owner === false)
    throw new Error(`only the owner of workspace "${datamate.name}" can attach connections to it; your connection is saved to your account. Link a workspace you own, or sign in as its owner`)
  let keys: string[] = []
  if (!datamate.integrations.some((e) => String(e.id) === integrationId)) {
    const catalog = await backend.integrationsCatalog(cfg)
    const list: any[] = Array.isArray(catalog) ? catalog : ((catalog as any)?.integrations ?? [])
    const found = list.find((c) => String(c?.id) === integrationId)
    keys = (found?.tools ?? []).map((t: any) => t?.key).filter((k: unknown): k is string => typeof k === "string")
  }
  await backend.updateDatamateIntegrations(cfg, datamateId, attachToIntegrations(datamate.integrations, integrationId, connectionId, keys))
}

async function syncReal(
  id: ProviderId,
  cfg: backend.BackendConfig,
  det: Detection | undefined,
  rec: StoredProvider | undefined,
  account: string | null,
  onStep?: (label: string, done: boolean) => void,
): Promise<SyncOutcome> {
  const collected = collectConfig(id, det, rec)
  const steps: SyncStep[] = []
  const step = (l: string) => {
    steps.push({ label: l, ok: true })
    onStep?.(l, true)
  }
  const reportWorkspace = (w: NonNullable<UpsertResult["workspace"]>): SyncOutcome => {
    if ("error" in w) return { id, result: "failed", reason: ATTACH_FAILED_PREFIX + w.error, steps }
    if ("attached" in w) step(`Attached to workspace "${w.attached}"`)
    else {
      steps.push({ label: NOT_LINKED_LABEL, ok: false })
      onStep?.(NOT_LINKED_LABEL, false)
    }
    return { id, result: "synced", steps }
  }
  if ("reason" in collected) {
    // Nothing local to upload, but a connection saved earlier may still need attaching to the workspace.
    if (!(rec?.registered && rec.synced && rec.connectionId && !rec.rejected)) return { id, result: "skipped", reason: collected.reason, steps: [] }
    try {
      const present = (await backend.listOwnConnections(cfg)).some((c) => c.id === rec.connectionId && c.integration_id === INTEGRATION_IDS[id])
      if (!present) return { id, result: "skipped", reason: collected.reason, steps: [] }
      step("Connection already in the workspace")
      return reportWorkspace(await attachToBoundWorkspace(cfg, id, rec.connectionId))
    } catch (e) {
      return { id, result: "failed", reason: e instanceof Error ? e.message : String(e), steps }
    }
  }
  try {
    const res = await upsertManaged(cfg, id, collected.config)
    step(res.created ? "Created connection" : "Updated connection")
    const next = loadStore()
    if (!res.isValid) {
      next.providers[id] = { ...next.providers[id], registered: true, account, source: next.providers[id]?.source ?? det?.source, synced: true, rejected: true, connectionId: res.connectionId, updatedAt: new Date().toISOString() }
      saveStore(next)
      return { id, result: "failed", reason: res.message ?? "connection test failed", steps }
    }
    next.providers[id] = {
      ...next.providers[id],
      registered: true,
      account,
      source: next.providers[id]?.source ?? det?.source,
      synced: true,
      rejected: false,
      connectionId: res.connectionId,
      updatedAt: new Date().toISOString(),
    }
    saveStore(next)
    return reportWorkspace(res.workspace ?? { notLinked: true })
  } catch (e) {
    return { id, result: "failed", reason: e instanceof Error ? e.message : String(e), steps }
  }
}

export function disconnect(id: ProviderId): boolean {
  const store = loadStore()
  const had = Boolean(store.providers[id]?.registered)
  const rec = store.providers[id]
  if (rec) store.providers[id] = { detection: rec.detection, updatedAt: new Date().toISOString() }
  saveStore(store)
  deleteSecret(id)
  purgeCredentialSecrets(id, rec)
  const remote = readJson<Record<string, unknown>>(remotePath(), {})
  const hadRemote = id in remote
  if (hadRemote) {
    delete remote[id]
    writeJson(remotePath(), remote)
  }
  return had || hadRemote
}

/**
 * Removes the provider's connections that this tool made in the workspace (named after this
 * machine), so a disconnect does not leave a copy behind. Connections made by hand in the web app
 * are left alone. Returns how many went.
 */
export async function disconnectRemote(id: ProviderId, cfg?: backend.BackendConfig | null): Promise<number> {
  const config = cfg === undefined ? await realConfig() : cfg
  if (!config) return 0
  const name = managedName(id)
  const managed = (await backend.listOwnConnections(config)).filter((c) => c.integration_id === INTEGRATION_IDS[id] && c.name === name)
  for (const c of managed) await backend.deleteConnection(config, c.id)
  return managed.length
}

/** Dev aid: marks a connected provider's access as expired so the expired state can be shown. */
export function expireProvider(id: ProviderId): boolean {
  const store = loadStore()
  const rec = store.providers[id]
  if (!rec?.registered) return false
  rec.expiresAt = new Date(Date.now() - 1000).toISOString()
  saveStore(store)
  return true
}

export type TokenOutcome =
  | { status: "ok"; token: string; expiresAt: string | null }
  | { status: "not_connected" | "unavailable" | "failed"; message: string }

/** The stored local credential for local tools; it says how to fix it when there is none or it was refused. */
export async function getToken(id: ProviderId): Promise<TokenOutcome> {
  const name = PROVIDER_NAMES[id]
  const fix = `Run: altimate integrations update ${id} (or connect ${id} --local-only)`
  const rec = loadStore().providers[id]
  if (!rec?.registered) return { status: "not_connected", message: `${name} is not connected. Run: altimate integrations connect ${id} --local-only` }
  const secret = readSecret(id)
  if (!secret) return { status: "unavailable", message: `No ${name} credential is stored on this machine. ${fix}` }
  if (rec.rejected) return { status: "failed", message: `${name} rejected the stored credential. ${fix}` }
  if (isExpired(rec.expiresAt)) return { status: "failed", message: `The stored ${name} credential has expired. ${fix}` }
  return { status: "ok", token: secret, expiresAt: rec.expiresAt ?? null }
}

export function openBrowser(url: string) {
  const [bin, ...pre] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"]
  try {
    spawnSync(bin, [...pre, url], { stdio: "ignore", timeout: 5000 })
  } catch {}
}
