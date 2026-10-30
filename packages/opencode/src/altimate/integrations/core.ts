// altimate_change - new file
//
// One-click local integrations: detection of existing credentials, local storage, the loopback
// browser consent flow and a mocked workspace sync. The workspace side is simulated: nothing is
// sent anywhere, the request that would be made is recorded in a local file.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { Global } from "../../global"
import * as backend from "./backend"

export type ProviderId = "github" | "jira" | "linear"
export const PROVIDER_IDS: ProviderId[] = ["github", "jira", "linear"]
export const PROVIDER_NAMES: Record<ProviderId, string> = { github: "GitHub", jira: "Jira", linear: "Linear" }
export const SCOPES: Record<ProviderId, string[]> = {
  github: ["Read repositories and pull requests", "Read issues and comments", "Read your profile"],
  jira: ["Read issues and projects", "Read comments", "Read your profile"],
  linear: ["Read issues and projects", "Read comments", "Read your profile"],
}
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
  /** Workspace connection id when the connection was saved to the workspace. */
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
  /** Where a workspace sync said the credential came from; reused so a later sync updates the same connection. */
  syncSource?: { kind: "cli" | "env" | "mcp"; label: string }
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
export const mockTtlSeconds = () => {
  const n = Number(process.env.ALTIMATE_INTEGRATIONS_MOCK_TTL_SECONDS)
  return Number.isFinite(n) && n > 0 ? n : 3600
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

/** Local status merged with the workspace view of this user's connections (real mode only). */
export function mergeRemote(local: StatusResult, remote: backend.RemoteProvider[], now = Date.now()): StatusResult {
  const providers = local.providers.map((p): ProviderStatus => {
    const r = remote.find((x) => x.integration_id === p.id)
    if (!r || r.connection_id == null || p.state === "rejected") return p
    const remoteExpired = r.expired || isExpired(r.expires_at, now)
    // An expired copy is reported as expired; only a live one the provider refused counts as rejected.
    const remoteRejected = !remoteExpired && r.is_valid === false
    const rs = typeof r.source === "string" ? { kind: "cli" as const, label: r.source } : r.source?.label ? { kind: (r.source.kind as SourceKind) ?? "cli", label: r.source.label } : null
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
        sync: p.sync === "blocked" ? p.sync : "synced",
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
    const remote = await backend.connectionStatus(cfg)
    return { ...mergeRemote(local, remote.providers ?? []), workspace: { name: cfg.tenant, tenant: cfg.tenant } }
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

/** The connection config to upload for a provider, read from where it was detected. Never printed. */
export function collectConfig(id: ProviderId, det: Detection | undefined, rec: StoredProvider | undefined): { config: Record<string, unknown> } | { reason: string } {
  if (rec?.registered && rec.variant) {
    const config: Record<string, unknown> = { ...rec.values, auth_type: "token" }
    for (const field of rec.secretFields ?? []) {
      const value = readSecret(secretKey("cred", id, field))
      if (!value) return { reason: "no local credential to upload" }
      config[field] = value
    }
    return { config }
  }
  if (rec?.registered && rec.source?.kind === "browser") {
    const secret = readSecret(id)
    if (!secret) return { reason: "no local credential to upload" }
    const oauth = { auth_type: "oauth", expires_at: rec.expiresAt ?? null }
    if (id === "github") return { config: { github_token: secret, ...oauth } }
    if (id === "linear") return { config: { linearApiKey: secret, ...oauth } }
    return { reason: "reconnect Jira to save it to the workspace" }
  }
  if (!det) return { reason: "nothing detected" }
  if (id === "github") {
    let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (det.source.kind === "cli") {
      const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
      if (r.status === 0 && r.stdout.trim()) token = r.stdout.trim()
    }
    return token ? { config: { github_token: token, auth_type: "token" } } : { reason: "could not read the GitHub token" }
  }
  if (id === "linear") {
    const key = process.env.LINEAR_API_KEY
    return key ? { config: { linearApiKey: key, auth_type: "token" } } : { reason: "set LINEAR_API_KEY to sync Linear" }
  }
  const token = process.env.JIRA_API_TOKEN
  const email = process.env.JIRA_USER || det.account
  const domain = jiraDomain(det)
  if (!token || !email || !domain) return { reason: "set JIRA_API_TOKEN (and JIRA_USER) to sync Jira" }
  return { config: { jiraApiToken: token, jiraEmail: email, jiraDomain: domain, auth_type: "token" } }
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
  if ("reason" in collected) return { id, result: "skipped", reason: collected.reason, steps: [] }
  const kind = rec?.syncSource?.kind ?? (det?.source.kind === "env" || det?.source.kind === "mcp" ? det.source.kind : "cli")
  const label = rec?.syncSource?.label ?? det?.source.label ?? rec?.source?.label ?? "altimate"
  const steps: SyncStep[] = []
  const step = (l: string) => {
    steps.push({ label: l, ok: true })
    onStep?.(l, true)
  }
  try {
    const res = await backend.syncConnection(cfg, { integration_id: INTEGRATION_IDS[id], config: collected.config, source: { kind, label, machine: os.hostname() } })
    step("POST /integrations/connections/sync")
    if (!res.is_valid) return { id, result: "failed", reason: res.message ?? "connection test failed", steps }
    step(res.created ? "Created connection" : "Updated connection")
    const next = loadStore()
    next.providers[id] = {
      ...next.providers[id],
      registered: true,
      account,
      source: next.providers[id]?.source ?? det?.source,
      synced: true,
      connectionId: res.connection_id,
      updatedAt: new Date().toISOString(),
    }
    saveStore(next)
    return { id, result: "synced", steps }
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
 * Removes the provider's connections that this tool made in the workspace (a
 * browser sign-in or a sync), so a disconnect does not leave a copy behind.
 * Hand-made connections from the web app are left alone. Returns how many went.
 */
export async function disconnectRemote(id: ProviderId, cfg?: backend.BackendConfig | null): Promise<number> {
  const config = cfg === undefined ? await realConfig() : cfg
  if (!config) return 0
  let removed = 0
  // The status lists one connection per provider; repeat while a managed one remains.
  for (let round = 0; round < 5; round++) {
    const remote = (await backend.connectionStatus(config)).providers.find((p) => p.integration_id === id)
    const managed = remote?.connection_id != null && (remote.auth_type === "oauth" || (remote.source != null && remote.source !== ""))
    if (!remote || !managed) break
    await backend.deleteConnection(config, remote.connection_id!)
    removed++
  }
  return removed
}

// ---------------------------------------------------------------- browser consent flow

export interface ConnectOptions {
  id: ProviderId
  port?: number
  localOnly?: boolean
  timeoutMs?: number
  account?: string | null
  onListening?: (url: string) => void
  /** The earlier access expired: the consent page says so and the saved connection is reused. */
  reauth?: boolean
  /** Real mode: open the provider authorize URL directly instead of the Altimate consent page. */
  noFrontend?: boolean
}
export interface ConnectResult {
  provider: ProviderId
  status: "connected" | "cancelled" | "timeout" | "error"
  sync: "synced" | "local"
  account: string | null
  url: string
  credential?: string
  expiresAt?: string | null
  connectionId?: number | null
  /** Real mode: the connection now lives in the workspace and no secret is kept here. */
  saved?: boolean
  message?: string
}

export function mockCredential(id: ProviderId): string {
  const rand = crypto.randomBytes(12).toString("hex")
  return { github: `ghu_demo_${rand}`, jira: `ATATT_demo_${rand}`, linear: `lin_oauth_demo_${rand}` }[id]
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

const LOGOS: Record<ProviderId, string> = {
  github: `<svg viewBox="0 0 16 16" width="34" height="34" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`,
  jira: `<svg viewBox="0 0 32 32" width="34" height="34"><path fill="#2684ff" d="M16 2 4 14l12 12 12-12z"/><path fill="#0052cc" d="M16 9 9 16l7 7 7-7z"/></svg>`,
  linear: `<svg viewBox="0 0 32 32" width="34" height="34"><circle cx="16" cy="16" r="14" fill="#5e6ad2"/><path d="M7 19l6 6M7 14l11 11M9 9l14 14M14 7l11 11" stroke="#fff" stroke-width="1.6" fill="none"/></svg>`,
}

const CSS = `:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--fg:#14171f;--mut:#667085;--line:#e4e7ec;--acc:#5b5bf0}
@media(prefers-color-scheme:dark){:root{--bg:#0d0f14;--card:#161922;--fg:#eef0f6;--mut:#98a2b3;--line:#262b38;--acc:#8b8bff}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
.card{width:min(460px,92vw);background:var(--card);border:1px solid var(--line);border-radius:18px;padding:32px;box-shadow:0 12px 40px rgba(0,0,0,.12)}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.2px;color:var(--acc);margin-bottom:22px}
.pair{display:flex;align-items:center;gap:14px;margin-bottom:18px}.dot{width:54px;height:54px;border-radius:14px;border:1px solid var(--line);display:grid;place-items:center}
h1{font-size:20px;margin:0 0 6px}p{color:var(--mut);margin:0 0 18px}.acct{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:16px}
.acct b{display:block}.acct input{width:100%;margin-top:6px;padding:9px 10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg)}
ul{margin:0 0 18px;padding:0;list-style:none}li{padding:6px 0;color:var(--fg)}li:before{content:"✓";color:var(--acc);margin-right:10px;font-weight:700}
label.t{display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:12px;margin-bottom:22px}
label.t.off{opacity:.55}.row{display:flex;gap:10px}button{flex:1;padding:11px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--fg)}
button.go{background:var(--acc);border-color:var(--acc);color:#fff}.ok{text-align:center}.ok .big{font-size:44px}small{color:var(--mut)}`

export function consentPage(id: ProviderId, state: string, opts: { account: string | null; syncDisabled: boolean; reason?: string; reauth?: boolean }): string {
  const name = PROVIDER_NAMES[id]
  const acct =
    id === "jira" && !opts.account
      ? `<div class="acct"><b>Jira site or email</b><input id="acct" placeholder="you@company.com or company.atlassian.net"></div>`
      : `<div class="acct"><small>Account</small><b id="acctv">${esc(opts.account ?? "Signed-in account")}</b></div>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ${esc(name)} · Altimate Code</title><style>${CSS}</style></head><body><main class="card">
<div class="brand"><span>◆</span> Altimate Code</div>
<div class="pair"><div class="dot">◆</div><span>⇄</span><div class="dot">${LOGOS[id]}</div></div>
${opts.reauth ? `<h1>Your ${esc(name)} access expired. Reconnect to continue.</h1><p>Approve again to keep Altimate Code working with ${esc(name)}.</p>` : `<h1>Altimate Code wants to connect ${esc(name)}</h1><p>This lets Altimate Code work with your ${esc(name)} data from the terminal.</p>`}
${acct}
<ul>${SCOPES[id].map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
<label class="t${opts.syncDisabled ? " off" : ""}"><input type="checkbox" id="sync" ${opts.syncDisabled ? "disabled" : "checked"}><span>Also save to my Altimate workspace${opts.syncDisabled ? `<br><small>${esc(opts.reason ?? "Kept on this machine")}</small>` : `<br><small>Private to you</small>`}</span></label>
<div class="row"><button id="cancel">Cancel</button><button class="go" id="allow">Allow</button></div>
</main><script>
const state=${JSON.stringify(state)};
async function send(choice){const a=document.getElementById('acct');
const r=await fetch('/callback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state,choice,sync:document.getElementById('sync').checked,account:a?a.value:undefined})});
document.body.innerHTML=await r.text();}
document.getElementById('allow').onclick=()=>send('allow');document.getElementById('cancel').onclick=()=>send('cancel');
</script></body></html>`
}

function resultPage(ok: boolean, name: string): string {
  return `<style>${CSS}</style><main class="card ok"><div class="big">${ok ? "✅" : "✋"}</div><h1>${ok ? `${esc(name)} connected` : "Cancelled"}</h1><p>${
    ok ? "You can return to your terminal." : "Nothing was connected. You can close this tab."
  }</p></main>`
}

/** Error variant: shown for an invalid or expired state, or a failed exchange. */
export function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Altimate Code</title></head><body><style>${CSS}</style><main class="card ok"><div class="big">⚠️</div><h1>Could not connect</h1><p>${esc(message)}</p></main></body></html>`
}
const INVALID_STATE = "Invalid or expired state. Start again from your terminal."

export async function runConnect(opts: ConnectOptions): Promise<ConnectResult> {
  const { id } = opts
  const state = crypto.randomBytes(16).toString("hex")
  const blocked = isBlocked(id)
  const syncDisabled = blocked || Boolean(opts.localOnly)
  const reason = blocked ? "Blocked by your sync policy" : "Local only for this run"
  const det = scan().find((d) => d.id === id && d.syncable)
  const account = opts.account ?? det?.account ?? null

  let finish!: (r: Omit<ConnectResult, "url">) => void
  const done = new Promise<Omit<ConnectResult, "url">>((res) => (finish = res))
  let settled = false

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method === "GET" && url.pathname === `/connect/${id}`) {
      if (url.searchParams.get("state") !== state) {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8" }).end(errorPage(INVALID_STATE))
        return
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(consentPage(id, state, { account, syncDisabled, reason, reauth: opts.reauth }))
      return
    }
    if (req.method === "POST" && url.pathname === "/callback") {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        let data: any = {}
        try {
          data = JSON.parse(body)
        } catch {}
        const given = Buffer.from(String(data.state ?? ""))
        const want = Buffer.from(state)
        if (settled || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
          res.writeHead(403, { "content-type": "text/html; charset=utf-8" }).end(errorPage(INVALID_STATE))
          return
        }
        settled = true
        if (data.choice === "allow") {
          const acct = (typeof data.account === "string" && data.account.trim()) || account
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(resultPage(true, PROVIDER_NAMES[id]))
          finish({
            provider: id,
            status: "connected",
            sync: data.sync === false || syncDisabled ? "local" : "synced",
            account: acct,
            credential: mockCredential(id),
            expiresAt: new Date(Date.now() + mockTtlSeconds() * 1000).toISOString(),
          })
        } else {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(resultPage(false, PROVIDER_NAMES[id]))
          finish({ provider: id, status: "cancelled", sync: "local", account })
        }
      })
      return
    }
    res.writeHead(404).end("Not found")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port ?? 0, "127.0.0.1", resolve)
  })
  const port = (server.address() as { port: number }).port
  const url = `http://127.0.0.1:${port}/connect/${id}?state=${state}`
  opts.onListening?.(url)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Omit<ConnectResult, "url">>((res) => {
    timer = setTimeout(() => res({ provider: id, status: "timeout", sync: "local", account }), opts.timeoutMs ?? 5 * 60 * 1000)
  })
  try {
    const r = await Promise.race([done, timeout])
    return { ...r, url }
  } finally {
    clearTimeout(timer)
    setTimeout(() => server.close(), 200)
    server.closeIdleConnections?.()
  }
}

/** Persists a completed connection locally; the sync step is separate. */
export function registerConnection(result: ConnectResult) {
  if (result.status !== "connected") return
  if (result.credential) storeSecret(result.provider, result.credential)
  else if (result.saved) deleteSecret(result.provider)
  else return
  const store = loadStore()
  store.providers[result.provider] = {
    ...store.providers[result.provider],
    registered: true,
    account: result.account,
    source: { kind: "browser", label: "browser consent" },
    synced: Boolean(result.saved),
    expiresAt: result.expiresAt ?? null,
    connectionId: result.connectionId ?? null,
    updatedAt: new Date().toISOString(),
  }
  saveStore(store)
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

// ---------------------------------------------------------------- real-mode browser flow

function callbackPage(kind: "ok" | "cancelled" | "error", name: string, message?: string): string {
  if (kind === "error") return errorPage(message ?? "Something went wrong. Start again from your terminal.")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Altimate Code</title></head><body>${resultPage(kind === "ok", name)}</body></html>`
}

/** Browser consent against the Altimate backend: the frontend consent page, then a code exchange. */
export async function runRealConnect(cfg: backend.BackendConfig, opts: ConnectOptions): Promise<ConnectResult> {
  const { id } = opts
  const name = PROVIDER_NAMES[id]
  const state = crypto.randomBytes(16).toString("hex")
  const save = !opts.localOnly && !isBlocked(id)
  const connectionId = opts.reauth ? (loadStore().providers[id]?.connectionId ?? null) : null
  const base = { provider: id, sync: "local" as const, account: null as string | null }

  let finish!: (r: Omit<ConnectResult, "url">) => void
  const done = new Promise<Omit<ConnectResult, "url">>((res) => (finish = res))
  let settled = false

  const html = (res: http.ServerResponse, code: number, body: string) =>
    res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method !== "GET" || url.pathname !== "/callback") return void res.writeHead(404).end("Not found")
    const given = Buffer.from(url.searchParams.get("state") ?? "")
    const want = Buffer.from(state)
    if (settled || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return html(res, 403, errorPage(INVALID_STATE))
    const error = url.searchParams.get("error")
    const code = url.searchParams.get("code")
    if (error) {
      settled = true
      if (error === "access_denied") {
        html(res, 200, callbackPage("cancelled", name))
        return finish({ ...base, status: "cancelled" })
      }
      const message = "The provider reported an error. Start again from your terminal."
      html(res, 200, callbackPage("error", name, message))
      return finish({ ...base, status: "error", message })
    }
    if (!code) return html(res, 400, errorPage("The sign-in response had no code."))
    settled = true
    try {
      const ex = await backend.exchangeCode(cfg, code)
      if (!ex.saved && !ex.access_token) throw new backend.BackendError("The backend returned no token.", 0, null)
      html(res, 200, callbackPage("ok", name))
      finish({
        ...base,
        status: "connected",
        sync: ex.saved ? "synced" : "local",
        account: ex.account,
        expiresAt: ex.expires_at,
        connectionId: ex.connection_id,
        saved: ex.saved,
        credential: ex.saved ? undefined : (ex.access_token ?? undefined),
      })
    } catch (e) {
      const message = e instanceof backend.BackendError && e.code === "handoff_code_invalid" ? "This sign-in link was already used or expired. Start again from your terminal." : e instanceof Error ? e.message : String(e)
      html(res, 200, callbackPage("error", name, message))
      finish({ ...base, status: "error", message })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port ?? 0, "127.0.0.1", resolve)
  })
  const port = (server.address() as { port: number }).port
  const redirect = `http://127.0.0.1:${port}/callback`
  const shutdown = () => {
    setTimeout(() => server.close(), 200)
    server.closeIdleConnections?.()
  }

  let url: string
  try {
    if (opts.noFrontend || !cfg.frontendUrl) {
      url = (await backend.startOAuth(cfg, id, { redirect_uri: redirect, client_state: state, save_to_workspace: save, connection_id: connectionId })).authorize_url
    } else {
      const q = new URLSearchParams({ provider: id, redirect, state, save: save ? "1" : "0" })
      if (connectionId != null) q.set("connection_id", String(connectionId))
      url = `${cfg.frontendUrl}/cli/integrations/connect?${q}`
    }
  } catch (e) {
    shutdown()
    return { ...base, status: "error", url: "", message: e instanceof backend.BackendError && e.code === "provider_not_configured" ? `${name} is not set up for this workspace yet.` : e instanceof Error ? e.message : String(e) }
  }
  opts.onListening?.(url)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Omit<ConnectResult, "url">>((res) => {
    timer = setTimeout(() => res({ ...base, status: "timeout" }), opts.timeoutMs ?? 5 * 60 * 1000)
  })
  try {
    return { ...(await Promise.race([done, timeout])), url }
  } finally {
    clearTimeout(timer)
    shutdown()
  }
}

export interface ConnectDeps {
  connect?: (opts: ConnectOptions) => Promise<{ result: ConnectResult; sync: "synced" | "local" }>
}

/** Runs the browser consent (real or mock), stores the outcome and syncs when the user allowed it. */
export async function connectProvider(
  opts: ConnectOptions & { onStep?: (label: string, done: boolean) => void; pace?: number },
): Promise<{ result: ConnectResult; sync: "synced" | "local" }> {
  const cfg = await realConfig()
  const result = cfg ? await runRealConnect(cfg, opts) : await runConnect(opts)
  registerConnection(result)
  let sync: "synced" | "local" = cfg ? result.sync : "local"
  if (!cfg && result.status === "connected" && result.sync === "synced") {
    const o = await syncProvider(opts.id, opts.onStep, opts.pace ?? 0)
    if (o.result === "synced") sync = "synced"
  }
  return { result, sync }
}

export type TokenOutcome =
  | { status: "ok"; token: string; expiresAt: string | null; reauthed: boolean }
  | { status: "not_connected" | "unavailable" | "failed"; message: string }

/** A usable token for local tools. Expired access re-runs the browser consent first. */
export async function getToken(id: ProviderId, deps: ConnectDeps & { onListening?: (url: string) => void; noFrontend?: boolean } = {}): Promise<TokenOutcome> {
  const name = PROVIDER_NAMES[id]
  const rec = loadStore().providers[id]
  if (!rec?.registered) return { status: "not_connected", message: `${name} is not connected. Run: altimate integrations connect ${id} --local-only` }
  let secret = readSecret(id)
  if (!secret)
    return {
      status: "unavailable",
      message: `${name} is saved to your Altimate workspace and no token is kept on this machine. Run: altimate integrations connect ${id} --local-only`,
    }
  let reauthed = false
  if (isExpired(rec.expiresAt)) {
    const run = deps.connect ?? ((o: ConnectOptions) => connectProvider(o))
    const { result } = await run({ id, reauth: true, localOnly: true, noFrontend: deps.noFrontend, onListening: deps.onListening })
    if (result.status !== "connected") return { status: "failed", message: result.message ?? `${name} access expired and was not renewed (${result.status}).` }
    secret = result.credential ?? readSecret(id)
    if (!secret) return { status: "unavailable", message: `${name} was renewed but no token is available on this machine.` }
    reauthed = true
  }
  return { status: "ok", token: secret, expiresAt: loadStore().providers[id]?.expiresAt ?? rec.expiresAt ?? null, reauthed }
}

export function openBrowser(url: string) {
  const [bin, ...pre] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"]
  try {
    spawnSync(bin, [...pre, url], { stdio: "ignore", timeout: 5000 })
  } catch {}
}
