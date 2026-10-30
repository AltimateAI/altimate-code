// altimate_change - new file
//
// Credentials flow for the integrations: the fields each provider asks for (the same ones the
// workspace web form uses), draft values, reading a secret from the clipboard, validation straight
// against the provider and the connect/update steps that keep a credential local or share it with
// the workspace. A secret is never returned, printed or logged: callers only ever see a masked tail.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import * as core from "./core"
import * as backend from "./backend"
import type { ProviderId, Source, StoredProvider } from "./core"

export interface FieldDef {
  name: string
  label: string
  secret: boolean
  required: boolean
}
export interface VariantDef {
  id: string
  label: string
  fields: FieldDef[]
}
export type Catalog = Partial<Record<ProviderId, VariantDef[]>>

export const BUILTIN_CATALOG: Record<ProviderId, VariantDef[]> = {
  github: [{ id: "token", label: "Personal access token", fields: [{ name: "github_token", label: "Personal access token", secret: true, required: true }] }],
  jira: [
    {
      id: "cloud",
      label: "Jira Cloud",
      fields: [
        { name: "jiraDomain", label: "Site", secret: false, required: true },
        { name: "jiraEmail", label: "Email", secret: false, required: true },
        { name: "jiraApiToken", label: "API token", secret: true, required: true },
      ],
    },
    {
      id: "server",
      label: "Jira Server / Data Center",
      fields: [
        { name: "jiraBaseUrl", label: "Base URL", secret: false, required: true },
        { name: "jiraPatToken", label: "Personal access token", secret: true, required: true },
      ],
    },
  ],
  linear: [{ id: "key", label: "Personal API key", fields: [{ name: "linearApiKey", label: "Personal API key", secret: true, required: true }] }],
}

// ---------------------------------------------------------------- catalog

const catalogPath = () => path.join(core.dataDir(), "integrations-catalog.json")
// Bookkeeping the backend keeps beside the credential; never asked of the user.
const IGNORED_FIELDS = new Set(["auth_type", "privacy", "expires_at", "type", "account", "source"])

const humanise = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)

function parseFields(config: unknown): FieldDef[] {
  const entries: [string, Record<string, any>][] = Array.isArray(config)
    ? config.filter(isObject).map((f) => [String(f.key ?? f.name ?? f.id ?? ""), f])
    : isObject(config)
      ? Object.entries(config).map(([k, v]) => [k, isObject(v) ? v : {}])
      : []
  const seen = new Set<string>()
  return entries
    .filter(([name]) => name && !IGNORED_FIELDS.has(name) && !seen.has(name) && Boolean(seen.add(name)))
    .map(([name, f]) => ({
      name,
      // The catalog names a field by `key` and shows it as `name`; a map names it by its key.
      label: String((f.key ? f.name : undefined) ?? f.label ?? f.title ?? f.display_name ?? humanise(name))
        .trim()
        .replace(/\s*:+$/, ""),
      secret: f.encrypted === true || f.secret === true || f.is_secret === true || f.type === "password",
      required: f.required === true,
    }))
}

/**
 * Reads the workspace catalog response; tolerates a bare list or one wrapped in `items`/`integrations`/`data`.
 * An entry's `config` is its default variant and `additionalConfigVariants` (or `variants`) lists the others.
 */
export function parseCatalog(data: unknown): Catalog {
  const list = Array.isArray(data) ? data : isObject(data) ? (data.items ?? data.integrations ?? data.data ?? []) : []
  const out: Catalog = {}
  for (const entry of Array.isArray(list) ? list : []) {
    if (!isObject(entry) || typeof entry.id !== "string" || !core.isProvider(entry.id)) continue
    const id = entry.id
    const first = BUILTIN_CATALOG[id][0]
    const base = parseFields(entry.config)
    const extra = entry.additionalConfigVariants ?? entry.variants
    const rawVariants = Array.isArray(extra) ? extra : isObject(extra) ? Object.entries(extra).map(([k, v]) => ({ id: k, ...(isObject(v) ? v : {}) })) : []
    const variants: VariantDef[] = rawVariants.filter(isObject).flatMap((v) => {
      const vid = String(v.id ?? v.key ?? v.value ?? v.name ?? "")
      const own = parseFields(v.config ?? v.fields)
      // A browser sign-in variant has no fields a person can type; this flow never offers it.
      if (/oauth/i.test(vid) || String(v.type ?? "").toLowerCase() === "oauth") return []
      return vid && own.length ? [{ id: vid, label: String(v.label ?? v.title ?? v.name ?? humanise(vid)), fields: own }] : []
    })
    const all = base.length ? [{ id: first.id, label: first.label, fields: base }, ...variants.filter((v) => v.id !== first.id)] : variants
    if (all.length) out[id] = all
  }
  return out
}

/** The catalog to use: the workspace's when signed in, else the last one saved, else the built-in table. */
export async function loadCatalog(id: ProviderId): Promise<VariantDef[]> {
  const cfg = await core.realConfig()
  if (cfg) {
    try {
      const fresh = parseCatalog(await backend.integrationsCatalog(cfg))
      if (Object.keys(fresh).length) {
        core.writeJson(catalogPath(), { ...core.readJson<Catalog>(catalogPath(), {}), ...fresh })
        if (fresh[id]) return fresh[id]!
      }
    } catch {}
  }
  return core.readJson<Catalog>(catalogPath(), {})[id] ?? BUILTIN_CATALOG[id]
}

// ---------------------------------------------------------------- reading values on this machine

interface Found {
  value: string
  source: Source
}

const FIELD_SOURCES: Record<string, { env: string[]; mcp: RegExp }> = {
  github_token: { env: ["GITHUB_TOKEN", "GH_TOKEN"], mcp: /^(GITHUB_(PERSONAL_ACCESS_)?TOKEN|GH_TOKEN)$/i },
  jiraApiToken: { env: ["JIRA_API_TOKEN", "ATLASSIAN_API_TOKEN"], mcp: /^(JIRA_API_TOKEN|ATLASSIAN_API_TOKEN)$/i },
  jiraPatToken: { env: ["JIRA_PAT_TOKEN", "JIRA_PERSONAL_TOKEN", "JIRA_PAT"], mcp: /^(JIRA_PAT_TOKEN|JIRA_PERSONAL_TOKEN|JIRA_PAT)$/i },
  linearApiKey: { env: ["LINEAR_API_KEY"], mcp: /^LINEAR_(API_KEY|TOKEN)$/i },
  jiraDomain: { env: ["JIRA_DOMAIN"], mcp: /^(JIRA_(URL|HOST|DOMAIN)|ATLASSIAN_(SITE|URL))$/i },
  jiraEmail: { env: ["JIRA_USER", "JIRA_EMAIL"], mcp: /^(JIRA_(USERNAME|EMAIL|USER)|ATLASSIAN_EMAIL)$/i },
  jiraBaseUrl: { env: ["JIRA_BASE_URL", "JIRA_URL"], mcp: /^JIRA_(URL|BASE_URL)$/i },
}

function fromMcpEnv(id: ProviderId, field: string): Found | undefined {
  const pattern = FIELD_SOURCES[field]?.mcp
  if (!pattern) return
  for (const servers of core.mcpServerMaps(core.homeDir(), process.cwd())) {
    for (const [name, server] of Object.entries(servers ?? {})) {
      if (!server || typeof server !== "object" || !core.providerMatchesMcp(id, name, server)) continue
      for (const [key, value] of Object.entries(server.env ?? {}))
        if (pattern.test(key) && typeof value === "string" && value.trim()) return { value: value.trim(), source: { kind: "mcp", label: `Claude MCP (${name})` } }
    }
  }
}

function fromEnv(field: string): Found | undefined {
  for (const name of FIELD_SOURCES[field]?.env ?? []) {
    const value = process.env[name]?.trim()
    if (value) return { value, source: { kind: "env", label: name } }
  }
}

function jiraCliConfig(): { server?: string; login?: string } {
  try {
    return core.parseJiraCliConfig(fs.readFileSync(path.join(core.homeDir(), ".config/.jira/.config.yml"), "utf8"))
  } catch {
    return {}
  }
}

function gitEmail(): string | undefined {
  const r = spawnSync("git", ["config", "user.email"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], env: process.env })
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined
}

function detectField(id: ProviderId, field: string): Found | undefined {
  if (core.demoMode()) return undefined
  if (field === "github_token") {
    const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: process.env })
    if (r.status === 0 && r.stdout.trim()) return { value: r.stdout.trim(), source: { kind: "cli", label: "gh CLI" } }
  }
  const cli = jiraCliConfig()
  const jiraCli: Source = { kind: "cli", label: "jira-cli" }
  if (field === "jiraDomain" && cli.server) return { value: core.normaliseJiraDomain(cli.server), source: jiraCli }
  if (field === "jiraBaseUrl" && cli.server) return { value: cli.server.trim().replace(/\/+$/, ""), source: jiraCli }
  if (field === "jiraEmail" && cli.login) return { value: cli.login, source: jiraCli }
  const found = fromEnv(field) ?? fromMcpEnv(id, field)
  if (found && field === "jiraDomain") return { ...found, value: core.normaliseJiraDomain(found.value) }
  if (found) return found
  if (field === "jiraEmail") {
    const email = gitEmail()
    if (email) return { value: email, source: { kind: "cli", label: "git config" } }
  }
}

/** Cloud when the site is empty, a bare subdomain or on atlassian.net; anything else is Server / Data Center. */
export function jiraVariantFor(site: string | undefined): "cloud" | "server" {
  const s = (site ?? "").trim()
  if (!s) return "cloud"
  const host = s.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "")
  return !host.includes(".") || /\.atlassian\.net$/i.test(host) ? "cloud" : "server"
}

const tokenUrls: Record<string, string | null> = {
  github: "https://github.com/settings/tokens/new?scopes=repo,read:user&description=Altimate",
  "jira:cloud": "https://id.atlassian.com/manage-profile/security/api-tokens",
  "jira:server": null,
  linear: "https://linear.app/settings/account/security",
}
export const tokenUrl = (id: ProviderId, variant: string): string | null => (id === "jira" ? tokenUrls[`jira:${variant}`] ?? null : tokenUrls[id])

export interface Resolved {
  id: ProviderId
  variant: string
  variants: VariantDef[]
  def: VariantDef
  values: Record<string, string>
  origin: Record<string, "draft" | "stored" | "detected">
  detected: Source[]
}

/** The value of every field of the chosen variant: drafts first, then the connected copy, then this machine. */
export async function resolve(id: ProviderId, variantId?: string): Promise<Resolved> {
  const variants = await loadCatalog(id)
  const rec = core.loadStore().providers[id]
  let want = variantId
  if (!want && id === "jira") {
    const site = rec?.drafts?.jiraBaseUrl || rec?.drafts?.jiraDomain || rec?.values?.jiraBaseUrl || rec?.values?.jiraDomain || detectField(id, "jiraBaseUrl")?.value || process.env.JIRA_DOMAIN
    want = jiraVariantFor(site)
  }
  const def = (want && variants.find((v) => v.id === want || v.id.toLowerCase().includes(want) || v.label.toLowerCase().includes(want))) || variants[0]
  const values: Record<string, string> = {}
  const origin: Resolved["origin"] = {}
  const detected: Source[] = []
  for (const f of def.fields) {
    const draft = f.secret ? core.readSecret(core.secretKey("draft", id, f.name)) : rec?.drafts?.[f.name]
    if (draft) {
      values[f.name] = draft
      origin[f.name] = "draft"
      continue
    }
    const stored = f.secret ? core.readSecret(core.secretKey("cred", id, f.name)) : rec?.values?.[f.name]
    if (stored) {
      values[f.name] = stored
      origin[f.name] = "stored"
      continue
    }
    const found = detectField(id, f.name)
    if (found) {
      values[f.name] = found.value
      origin[f.name] = "detected"
      detected.push(found.source)
    }
  }
  return { id, variant: def.id, variants, def, values, origin, detected }
}

export const maskTail = (secret: string) => (secret.length <= 8 ? "••••" : `••••${secret.slice(-4)}`)

export interface FieldView {
  name: string
  label: string
  secret: boolean
  required: boolean
  value: string | null
  hasValue: boolean
  masked: string | null
}
export interface FieldsResult {
  provider: ProviderId
  variant: string
  variants: string[]
  fields: FieldView[]
  tokenUrl: string | null
}

export async function describeFields(id: ProviderId, variantId?: string): Promise<FieldsResult> {
  const r = await resolve(id, variantId)
  return {
    provider: id,
    variant: r.variant,
    variants: r.variants.map((v) => v.id),
    fields: r.def.fields.map((f) => {
      const v = r.values[f.name]
      return {
        name: f.name,
        label: f.label,
        secret: f.secret,
        required: f.required,
        value: f.secret ? null : (v ?? null),
        hasValue: Boolean(v),
        masked: f.secret && v ? maskTail(v) : null,
      }
    }),
    tokenUrl: tokenUrl(id, r.variant),
  }
}

// ---------------------------------------------------------------- drafts

async function findField(id: ProviderId, name: string): Promise<FieldDef> {
  const known = new Map<string, FieldDef>()
  for (const v of [...(await loadCatalog(id)), ...BUILTIN_CATALOG[id]]) for (const f of v.fields) if (!known.has(f.name)) known.set(f.name, f)
  const f = known.get(name)
  if (!f) throw new Error(`${core.PROVIDER_NAMES[id]} has no field "${name}". Fields: ${[...known.keys()].join(", ")}.`)
  return f
}

/** Stores a non-secret value typed in for a provider, until it is connected. */
export async function setDraft(id: ProviderId, name: string, value: string) {
  const f = await findField(id, name)
  if (f.secret) throw new Error(`"${name}" is a secret. Use: altimate integrations set-secret ${id} ${name} --from-clipboard`)
  const store = core.loadStore()
  const rec = store.providers[id] ?? {}
  const trimmed = value.trim()
  const drafts = { ...rec.drafts }
  if (trimmed) drafts[name] = trimmed
  else delete drafts[name]
  store.providers[id] = { ...rec, drafts: Object.keys(drafts).length ? drafts : undefined }
  core.saveStore(store)
  return { provider: id, field: name }
}

export type SecretSource = { kind: "clipboard" } | { kind: "env"; name: string } | { kind: "stdin" }
export interface SecretDeps {
  clipboard?: () => string | undefined | Promise<string | undefined>
  stdin?: () => Promise<string>
}

/** Reads the system clipboard. Nothing but the text itself leaves this function. */
export function readClipboard(): string | undefined {
  const attempts: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbpaste", []]]
      : process.platform === "win32"
        ? [["powershell", ["-NoProfile", "-Command", "Get-Clipboard"]]]
        : [
            ["wl-paste", ["--no-newline"]],
            ["xclip", ["-o", "-selection", "clipboard"]],
            ["xsel", ["-ob"]],
          ]
  for (const [bin, args] of attempts) {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
    if (r.status === 0 && r.stdout) return r.stdout
  }
}

async function readStdin() {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString("utf8")
}

/** Reads a secret from the chosen source and keeps it as a draft in the secret store. Returns the masked tail only. */
export async function setSecretDraft(id: ProviderId, name: string, source: SecretSource, deps: SecretDeps = {}) {
  const f = await findField(id, name)
  if (!f.secret) throw new Error(`"${name}" is not a secret. Use: altimate integrations set ${id} ${name} <value>`)
  const raw =
    source.kind === "clipboard" ? await (deps.clipboard ?? readClipboard)() : source.kind === "env" ? process.env[source.name] : await (deps.stdin ?? readStdin)()
  const value = (raw ?? "").trim()
  const where = source.kind === "clipboard" ? "Clipboard" : source.kind === "env" ? `Environment variable ${source.name}` : "Standard input"
  if (!value) throw new Error(source.kind === "clipboard" ? "Clipboard doesn't contain a token" : `${where} is empty`)
  if (/\s/.test(value)) throw new Error(source.kind === "clipboard" ? "Clipboard doesn't contain a token" : `${where} doesn't contain a token`)
  core.storeSecret(core.secretKey("draft", id, name), value)
  return { provider: id, field: name, masked: maskTail(value) }
}

// ---------------------------------------------------------------- validation

export interface Validation {
  ok: boolean
  /** The provider refused the credential (401/403). False when it could not be reached. */
  rejected: boolean
  account: string | null
  expiresAt: string | null
  message: string | null
}

const githubApi = () => (process.env.ALTIMATE_INTEGRATIONS_GITHUB_API || "https://api.github.com").replace(/\/+$/, "")
const linearApi = () => process.env.ALTIMATE_INTEGRATIONS_LINEAR_API || "https://api.linear.app/graphql"
const jiraCloudBase = (site: string) => (process.env.ALTIMATE_INTEGRATIONS_JIRA_API || `https://${site}.atlassian.net`).replace(/\/+$/, "")

/** GitHub sends the expiry as `2026-11-01 00:00:00 UTC`. */
export function parseGithubExpiry(header: string | null): string | null {
  if (!header) return null
  const at = Date.parse(header.trim().replace(" UTC", "Z").replace(" ", "T"))
  return Number.isNaN(at) ? null : new Date(at).toISOString()
}

async function request(url: string, init: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {}
    return { res, data }
  } finally {
    clearTimeout(timer)
  }
}

const ok = (account: string | null, expiresAt: string | null = null): Validation => ({ ok: true, rejected: false, account, expiresAt, message: null })
const refused = (message: string): Validation => ({ ok: false, rejected: true, account: null, expiresAt: null, message })
const unreachable = (message: string): Validation => ({ ok: false, rejected: false, account: null, expiresAt: null, message })

/** Checks the credential straight against the provider; nothing goes to Altimate. */
export async function validate(id: ProviderId, variant: string, v: Record<string, string>): Promise<Validation> {
  const name = core.PROVIDER_NAMES[id]
  try {
    if (id === "github") {
      const { res, data } = await request(`${githubApi()}/user`, { headers: { Authorization: `Bearer ${v.github_token}`, Accept: "application/vnd.github+json", "User-Agent": "altimate-code" } })
      if (res.status === 401 || res.status === 403) return refused(`GitHub rejected the token (${res.status})${data?.message ? `: ${data.message}` : ""}`)
      if (!res.ok) return unreachable(`GitHub answered ${res.status}`)
      return ok(data?.login ?? null, parseGithubExpiry(res.headers.get("github-authentication-token-expiration")))
    }
    if (id === "jira") {
      let url: string
      let auth: string
      if (variant === "server") {
        const base = (v.jiraBaseUrl ?? "").replace(/\/+$/, "")
        const local = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(base)
        if (!/^https:\/\//i.test(base) && !local) return unreachable("The Jira base URL must start with https://")
        url = `${base}/rest/api/2/myself`
        auth = `Bearer ${v.jiraPatToken}`
      } else {
        const site = core.normaliseJiraDomain(v.jiraDomain ?? "")
        if (!/^[a-z0-9-]+$/i.test(site)) return unreachable(`"${v.jiraDomain}" is not a Jira site name, use the part before .atlassian.net`)
        url = `${jiraCloudBase(site)}/rest/api/3/myself`
        auth = `Basic ${Buffer.from(`${v.jiraEmail}:${v.jiraApiToken}`).toString("base64")}`
      }
      const { res, data } = await request(url, { headers: { Authorization: auth, Accept: "application/json" } })
      if (res.status === 401 || res.status === 403) return refused(`Jira rejected the credentials (${res.status})`)
      if (!res.ok) return unreachable(`Jira answered ${res.status}`)
      return ok(data?.emailAddress || data?.displayName || data?.name || null)
    }
    const { res, data } = await request(linearApi(), {
      method: "POST",
      headers: { Authorization: v.linearApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { email name } }" }),
    })
    const authError = data?.errors?.some((e: any) => e?.extensions?.code === "AUTHENTICATION_ERROR")
    if (res.status === 401 || res.status === 403 || authError) return refused(`Linear rejected the API key (${authError ? 401 : res.status})`)
    if (!res.ok || !data?.data?.viewer) return unreachable(`Linear answered ${res.status}`)
    return ok(data.data.viewer.email || data.data.viewer.name || null)
  } catch (e) {
    return unreachable(`Could not reach ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---------------------------------------------------------------- connect and update

export interface CredentialResult {
  provider: ProviderId
  status: "connected" | "rejected" | "missing_fields" | "failed"
  sync: "synced" | "local"
  account: string | null
  expiresAt: string | null
  message: string | null
  code?: string
  missing?: string[]
}

export interface CredentialOptions {
  id: ProviderId
  localOnly?: boolean
  /** Requires an existing connection and keeps its sync mode. */
  update?: boolean
  variant?: string
  onStep?: (label: string) => void
}

const MANUAL_SOURCE: Source = { kind: "cli", label: "Claude Code" }
const NOT_SIGNED_IN = "Not signed in to Altimate, kept local."

export async function connectCredentials(opts: CredentialOptions): Promise<CredentialResult> {
  const { id } = opts
  const name = core.PROVIDER_NAMES[id]
  const base = { provider: id, account: null, expiresAt: null }
  const rec = core.loadStore().providers[id]
  const local = (r: Omit<CredentialResult, "provider" | "account" | "expiresAt"> & Partial<CredentialResult>): CredentialResult => ({ ...base, ...r })
  if (opts.update && !rec?.registered)
    return local({ status: "failed", sync: "local", message: `${name} is not connected yet. Use connect first.`, code: "not_connected" })

  const r = await resolve(id, opts.variant ?? (opts.update ? rec?.variant : undefined))
  const missing = r.def.fields.filter((f) => f.required && !r.values[f.name])
  if (missing.length)
    return local({ status: "missing_fields", sync: "local", message: `Missing: ${missing.map((f) => f.label).join(", ")}`, code: "missing_fields", missing: missing.map((f) => f.name) })

  opts.onStep?.("Testing connection…")
  const check = await validate(id, r.variant, r.values)
  const blocked = core.isBlocked(id)
  if (!check.ok) {
    if (check.rejected && rec?.registered) {
      const store = core.loadStore()
      store.providers[id] = { ...store.providers[id], rejected: true, validatedAt: new Date().toISOString() }
      core.saveStore(store)
    }
    return local({ status: check.rejected ? "rejected" : "failed", sync: rec?.synced ? "synced" : "local", message: check.message ?? "Could not validate the credentials" })
  }

  const wantSync = opts.update ? Boolean(rec?.synced) : !opts.localOnly
  const cfg = wantSync && !blocked ? await core.realConfig() : null
  const handDone = Object.values(r.origin).includes("draft") || Object.values(r.origin).includes("stored")
  const detectedSource = r.detected[0]
  const source: Source = opts.update && rec?.syncSource ? rec.syncSource : handDone || !detectedSource ? MANUAL_SOURCE : detectedSource
  const secretFields = r.def.fields.filter((f) => f.secret).map((f) => f.name)
  const plain = Object.fromEntries(r.def.fields.filter((f) => !f.secret).map((f) => [f.name, r.values[f.name]]).filter(([, v]) => v))
  const stamp = new Date().toISOString()
  const common = { registered: true, account: check.account, variant: r.variant, values: plain, secretFields, validatedAt: stamp, rejected: false, expiresAt: check.expiresAt, drafts: undefined }
  const finish = (synced: boolean, extra: Partial<StoredProvider> = {}) => {
    const store = core.loadStore()
    store.providers[id] = { ...store.providers[id], ...common, source: handDone || !detectedSource ? MANUAL_SOURCE : detectedSource, synced, updatedAt: stamp, ...extra }
    core.saveStore(store)
    for (const f of secretFields) core.deleteSecret(core.secretKey("draft", id, f))
  }

  if (!cfg) {
    for (const f of secretFields) if (r.values[f]) core.storeSecret(core.secretKey("cred", id, f), r.values[f])
    if (secretFields[0] && r.values[secretFields[0]]) core.storeSecret(id, r.values[secretFields[0]])
    finish(false, { connectionId: null, syncSource: undefined })
    const notSignedIn = wantSync && !blocked
    return { ...base, provider: id, status: "connected", sync: "local", account: check.account, expiresAt: check.expiresAt, message: notSignedIn ? NOT_SIGNED_IN : blocked && wantSync ? "Sync is blocked for this provider, kept local." : null }
  }

  opts.onStep?.("Saving to your workspace…")
  const config: Record<string, unknown> = { auth_type: "token" }
  for (const f of r.def.fields) if (r.values[f.name]) config[f.name] = r.values[f.name]
  try {
    const res = await backend.syncConnection(cfg, { integration_id: core.INTEGRATION_IDS[id], config, source: { kind: source.kind as "cli" | "env" | "mcp", label: source.label, machine: os.hostname() } })
    if (!res.is_valid) {
      if (rec?.registered) {
        const store = core.loadStore()
        store.providers[id] = { ...store.providers[id], rejected: true, validatedAt: stamp }
        core.saveStore(store)
      }
      return local({ status: "rejected", sync: "local", message: res.message ?? `${name} rejected the credentials in the workspace` })
    }
    // The connection lives in the workspace; no secret is kept on this machine.
    for (const f of secretFields) core.deleteSecret(core.secretKey("cred", id, f))
    core.deleteSecret(id)
    finish(true, { connectionId: res.connection_id, syncSource: { kind: source.kind as "cli" | "env" | "mcp", label: source.label } })
    return { ...base, provider: id, status: "connected", sync: "synced", account: check.account, expiresAt: check.expiresAt, message: null }
  } catch (e) {
    return local({ status: "failed", sync: "local", message: e instanceof Error ? e.message : String(e) })
  }
}
