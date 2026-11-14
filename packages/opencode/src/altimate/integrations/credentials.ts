// altimate_change - new file
//
// Credentials flow for the integrations: the fields each provider asks for (the same ones the
// workspace web form uses), draft values, reading a secret from the clipboard, validation straight
// against the provider and the connect/update steps that keep a credential local or share it with
// the workspace. A secret is never returned, printed or logged: callers only ever see a masked tail.
import fs from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { IntegrationsCore as core } from "./core"
import { IntegrationsBackend as backend } from "./backend"
import { workspaceLabel } from "../workspace/workspace-name"
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

/** The saved catalog is per workspace login, so one tenant's fields are never shown for another. */
const catalogPath = (cfg: backend.BackendConfig) =>
  path.join(core.dataDir(), `integrations-catalog-${createHash("sha256").update(`${cfg.apiUrl}\n${cfg.tenant}`).digest("hex").slice(0, 12)}.json`)
// Bookkeeping the backend keeps beside the credential; never asked of the user.
const IGNORED_FIELDS = new Set(["auth_type", "privacy", "expires_at", "type", "account", "source"])

const humanise = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)

const isKnownSecretField = (name: string) => Object.values(core.BUILTIN_SECRET_FIELDS).some((names) => names.includes(name))

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
      secret: f.encrypted === true || f.secret === true || f.is_secret === true || f.type === "password" || isKnownSecretField(name),
      required: f.required === true,
    }))
}

/**
 * Reads the workspace catalog response; tolerates a bare list or one wrapped in `items`/`integrations`/`data`.
 * An entry's `config` is its default variant and `additionalConfigVariants` (or `variants`) lists the others.
 */
export function parseCatalog(data: unknown): Catalog {
  const out: Catalog = {}
  for (const entry of backend.catalogEntries(data)) {
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

/** The catalog to use: the workspace's when signed in (the last one saved for that login if it cannot be reached), else the built-in table. */
export async function loadCatalog(id: ProviderId, offline = false): Promise<VariantDef[]> {
  // The form fields need no login: one that cannot be read leaves the built-in catalog.
  const cfg = await core.realConfig().catch(() => null)
  if (!cfg) return BUILTIN_CATALOG[id]
  // Keeping a credential local does not need a fresh catalog, so only the saved one is used then.
  if (!offline)
    try {
      const fresh = parseCatalog(await backend.integrationsCatalog(cfg))
      if (Object.keys(fresh).length) {
        await core.withLock(() => core.writeJson(catalogPath(cfg), { ...core.readJson<Catalog>(catalogPath(cfg), {}), ...fresh }))
        if (fresh[id]) return fresh[id]!
      }
    } catch {}
  return core.readJson<Catalog>(catalogPath(cfg), {})[id] ?? BUILTIN_CATALOG[id]
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

/** A value that is only a reference to another environment variable, such as ${NAME} or $NAME, holds no credential until it is resolved. */
const isEnvReference = (value: string) => {
  const v = value.trim()
  return v.length === 0 || /^\$\{[^}]*\}$/.test(v) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)
}

/**
 * Whether a GitHub token's surroundings name a host other than github.com (GitHub Enterprise). Only github.com is
 * supported, and its validation goes to api.github.com, so such a token is never read: it would be sent to the wrong host.
 */
export function githubHostElsewhere(env: Record<string, unknown> | undefined, args: unknown[] = []): boolean {
  const keys = ["GITHUB_HOST", "GH_HOST", "GITHUB_API_URL", "GITHUB_SERVER_URL"]
  const named: unknown[] = keys.map((k) => env?.[k])
  // Arguments may name the host too: --gh-host, or KEY=value as in docker's -e or a shell wrapper.
  const assignment = new RegExp(`(?:^|[\\s"'])(?:${keys.join("|")})=([^\\s"']*)`, "g")
  args.forEach((a, i) => {
    if (a === "--gh-host") named.push(args[i + 1])
    else if (typeof a === "string" && a.startsWith("--gh-host=")) named.push(a.slice("--gh-host=".length))
    if (typeof a === "string") for (const m of a.matchAll(assignment)) named.push(m[1])
  })
  return named.some((v) => {
    if (typeof v !== "string" || !v.trim()) return false
    // A reference is resolved from this environment; one that cannot be cannot be confirmed as github.com.
    const value = isEnvReference(v) ? process.env[v.trim().replace(/^\$\{?|\}$/g, "")] : v
    if (!value?.trim()) return true
    const host = value.trim().replace(/^[a-z]+:\/\//i, "").split(/[/:]/)[0].toLowerCase()
    return host !== "github.com" && host !== "api.github.com"
  })
}

/** gh hands out GH_TOKEN or GITHUB_TOKEN as the github.com token whatever host they belong to, so it is not asked while they sit beside another host. */
export const ghMayReturnOtherHostToken = () => Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN) && githubHostElsewhere(process.env)

/** Whether an MCP server's environment holds a credential this flow reads for the provider, not just any value. */
export function mcpEnvHasToken(id: ProviderId, env: Record<string, string> | undefined, args: unknown[] = []): boolean {
  if (id === "github" && githubHostElsewhere(env, args)) return false
  const patterns = core.BUILTIN_SECRET_FIELDS[id].flatMap((field) => FIELD_SOURCES[field]?.mcp ?? [])
  return Object.entries(env ?? {}).some(([key, value]) => typeof value === "string" && !isEnvReference(value) && patterns.some((p) => p.test(key)))
}

function fromMcpEnv(id: ProviderId, field: string): Found | undefined {
  const pattern = FIELD_SOURCES[field]?.mcp
  if (!pattern) return
  for (const { scope, servers } of core.mcpServerMaps(core.homeDir(), process.cwd())) {
    for (const [name, server] of Object.entries(servers ?? {})) {
      if (!server || typeof server !== "object" || !core.providerMatchesMcp(id, name, server)) continue
      if (id === "github" && githubHostElsewhere(server.env, server.args ?? [])) continue
      for (const [key, value] of Object.entries(server.env ?? {}))
        if (pattern.test(key) && typeof value === "string" && !isEnvReference(value)) return { value: value.trim(), source: { kind: "mcp", label: `Claude MCP (${name}, ${scope})` } }
    }
  }
}

function fromEnv(field: string): Found | undefined {
  if (field === "github_token" && githubHostElsewhere(process.env)) return undefined
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
  if (field === "github_token" && !ghMayReturnOtherHostToken()) {
    // The token for github.com only, the host it is validated against, whatever GH_HOST says.
    const r = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: process.env })
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

/** Cloud when the site is empty, a bare subdomain or on atlassian.net; anything else is Server / Data Center, including an address with a scheme or a port and a host without a dot such as localhost. */
export function jiraVariantFor(site: string | undefined): "cloud" | "server" {
  const s = (site ?? "").trim()
  if (!s) return "cloud"
  const host = s.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "")
  if (/\.atlassian\.net(:\d+)?$/i.test(host)) return "cloud"
  if (/^[a-z]+:\/\//i.test(s) || /:\d+$/.test(host) || /^localhost$/i.test(host)) return "server"
  return host.includes(".") ? "server" : "cloud"
}

const tokenUrls: Record<string, string | null> = {
  github: "https://github.com/settings/tokens/new?scopes=repo,read:user&description=Altimate",
  "jira:cloud": "https://id.atlassian.com/manage-profile/security/api-tokens",
  "jira:server": null,
  linear: "https://linear.app/settings/account/security",
}
export const tokenUrl = (id: ProviderId, variant: string): string | null => (id === "jira" ? tokenUrls[core.isJiraServer(variant) ? "jira:server" : "jira:cloud"] : tokenUrls[id])

export interface Resolved {
  id: ProviderId
  variant: string
  variants: VariantDef[]
  def: VariantDef
  values: Record<string, string>
  origin: Record<string, "draft" | "stored" | "detected">
  detected: Source[]
  /** Why a token found on this machine was not filled in, by field name. */
  notes: Record<string, string>
}

/** The value of every field of the chosen variant: drafts first, then the connected copy, then this machine. `detectedOnly` reads this machine alone. */
export async function resolve(id: ProviderId, variantId?: string, offline = false, detectedOnly = false): Promise<Resolved> {
  const variants = await loadCatalog(id, offline)
  const rec = detectedOnly ? undefined : core.loadStore().providers[id]
  let want = variantId
  if (!want && id === "jira") {
    const site = rec?.drafts?.jiraBaseUrl || rec?.drafts?.jiraDomain || rec?.values?.jiraBaseUrl || rec?.values?.jiraDomain || detectField(id, "jiraBaseUrl")?.value || process.env.JIRA_DOMAIN
    want = jiraVariantFor(site)
  }
  const key = want?.toLowerCase()
  const match = key ? (variants.find((v) => v.id.toLowerCase() === key || v.label.toLowerCase() === key) ?? variants.find((v) => v.id.toLowerCase().includes(key) || v.label.toLowerCase().includes(key))) : undefined
  // A variant that was asked for and does not exist is an error: falling back to the first one would test and save a different credential type.
  if (variantId && !match) throw new Error(`${core.PROVIDER_NAMES[id]} has no variant "${variantId}". Variants: ${variants.map((v) => v.id).join(", ")}.`)
  const def = match || variants[0]
  const values: Record<string, string> = {}
  const origin: Resolved["origin"] = {}
  const detected: Source[] = []
  const foundFrom: Record<string, Source> = {}
  const notes: Record<string, string> = {}
  for (const f of def.fields) {
    const draft = detectedOnly ? undefined : f.secret ? await core.readSecret(core.secretKey("draft", id, f.name)) : rec?.drafts?.[f.name]
    if (draft) {
      values[f.name] = f.name === "jiraDomain" ? core.normaliseJiraDomain(draft) : draft
      origin[f.name] = "draft"
      continue
    }
    const stored = detectedOnly ? undefined : f.secret ? await core.readSecret(core.secretKey("cred", id, f.name)) : rec?.values?.[f.name]
    if (stored) {
      values[f.name] = f.name === "jiraDomain" ? core.normaliseJiraDomain(stored) : stored
      origin[f.name] = "stored"
      continue
    }
    const found = detectField(id, f.name)
    if (found) {
      values[f.name] = found.value
      origin[f.name] = "detected"
      foundFrom[f.name] = found.source
      detected.push(found.source)
    }
  }
  if (id === "jira") dropMismatchedJiraToken(def, values, origin, detected, foundFrom, notes)
  return { id, variant: def.id, variants, def, values, origin, detected, notes }
}

const JIRA_SITE_FIELDS = new Set(["jiraDomain", "jiraBaseUrl"])
/** The environment and jira-cli's own config are one place (jira-cli reads its token from the environment); each MCP server is its own. */
const sourceGroup = (s: Source) => (s.kind === "mcp" ? `mcp:${s.label}` : "machine")
const sameSource = (a: Source, b: Source) => sourceGroup(a) === sourceGroup(b)

/** A site found on this machine is only paired with a token found in the same place, so a token is never sent to a site that came from somewhere else. A typed or stored site is the user's own and pairs with any token. */
function dropMismatchedJiraToken(def: VariantDef, values: Record<string, string>, origin: Resolved["origin"], detected: Source[], foundFrom: Record<string, Source>, notes: Record<string, string>) {
  const site = def.fields.find((f) => JIRA_SITE_FIELDS.has(f.name) && foundFrom[f.name])
  if (!site) return
  for (const f of def.fields) {
    const from = foundFrom[f.name]
    if (!f.secret || !from || sameSource(from, foundFrom[site.name])) continue
    delete values[f.name]
    delete origin[f.name]
    detected.splice(detected.indexOf(from), 1)
    notes[f.name] = `Found in ${from.label}, but the site came from ${foundFrom[site.name].label}, so the token was not filled in`
  }
}

/** The config to upload for a provider found on this machine, read the same way connect reads it. Typed-in drafts and stored copies are never part of it. */
export async function detectedConfig(id: ProviderId): Promise<{ config: Record<string, unknown> } | { reason: string }> {
  const r = await resolve(id, undefined, false, true)
  const missing = r.def.fields.filter((f) => f.required && !r.values[f.name])
  if (missing.length) return { reason: [`Missing: ${missing.map((f) => f.label).join(", ")}`, ...missing.map((f) => r.notes[f.name]).filter(Boolean)].join(". ") }
  const config: Record<string, unknown> = {}
  for (const f of r.def.fields) if (r.values[f.name]) config[f.name] = r.values[f.name]
  return { config: core.withVariant(id, r.variant, config) }
}

// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
/** The last four characters of a secret, or nothing when they hold a control or direction character that must not reach a terminal. */
export const maskTail = (secret: string) => (secret.length <= 8 || UNPRINTABLE.test(secret.slice(-4)) ? "••••" : `••••${secret.slice(-4)}`)

export interface FieldView {
  name: string
  label: string
  secret: boolean
  required: boolean
  value: string | null
  hasValue: boolean
  masked: string | null
  note?: string
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
        ...(r.notes[f.name] ? { note: r.notes[f.name] } : {}),
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
  await core.updateStore((store) => {
    const rec = store.providers[id] ?? {}
    const trimmed = name === "jiraDomain" ? core.normaliseJiraDomain(value) : value.trim()
    const drafts = { ...rec.drafts }
    if (trimmed) drafts[name] = trimmed
    else delete drafts[name]
    store.providers[id] = { ...rec, drafts: Object.keys(drafts).length ? drafts : undefined }
  })
  return { provider: id, field: name }
}

/** The names of every secret field the provider can ask for, across its catalog variants. */
export async function catalogSecretFields(id: ProviderId): Promise<Set<string>> {
  const names = new Set<string>()
  for (const v of [...(await loadCatalog(id, true)), ...BUILTIN_CATALOG[id]]) for (const f of v.fields) if (f.secret) names.add(f.name)
  return names
}
const draftSecretNames = async (id: ProviderId) => new Set([...core.BUILTIN_SECRET_FIELDS[id], ...(core.loadStore().providers[id]?.secretFields ?? []), ...(await catalogSecretFields(id))])
/** Deletes the pasted secret drafts of every field the provider can ask for: those of each catalog variant and of the connected credential. */
export async function discardDraftSecrets(id: ProviderId) {
  const names = await draftSecretNames(id)
  await core.withLock(async () => {
    for (const name of names) await core.deleteSecret(core.secretKey("draft", id, name))
  })
}

/** Forgets everything typed or pasted into the form and not yet connected: its fields and secrets. A connected credential and its status are kept, so this also serves a cancelled update. */
export async function discardDrafts(id: ProviderId) {
  const names = await draftSecretNames(id)
  await core.withLock(async () => {
    for (const name of names) await core.deleteSecret(core.secretKey("draft", id, name))
    await core.updateStore((store) => {
      const rec = store.providers[id]
      if (rec?.drafts) store.providers[id] = { ...rec, drafts: undefined }
    })
  })
  return { provider: id }
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

const MIN_TOKEN_LENGTH = 8

/** Reads a secret from the chosen source and keeps it as a draft in the secret store. Returns the masked tail only. */
export async function setSecretDraft(id: ProviderId, name: string, source: SecretSource, deps: SecretDeps = {}) {
  const f = await findField(id, name)
  if (!f.secret) throw new Error(`"${name}" is not a secret. Use: altimate integrations set ${id} ${name} <value>`)
  const raw =
    source.kind === "clipboard" ? await (deps.clipboard ?? readClipboard)() : source.kind === "env" ? process.env[source.name] : await (deps.stdin ?? readStdin)()
  const value = (raw ?? "").trim()
  const where = source.kind === "clipboard" ? "Clipboard" : source.kind === "env" ? `Environment variable ${source.name}` : "Standard input"
  if (!value) throw new Error(source.kind === "clipboard" ? "Clipboard doesn't contain a token" : `${where} is empty`)
  if (/\s/.test(value) || (source.kind === "clipboard" && (value.length < MIN_TOKEN_LENGTH || value.includes("://"))))
    throw new Error(source.kind === "clipboard" ? "Clipboard doesn't contain a token" : `${where} doesn't contain a token`)
  await core.storeSecret(core.secretKey("draft", id, name), value)
  return { provider: id, field: name, masked: maskTail(value) }
}

// ---------------------------------------------------------------- validation

export interface Validation {
  ok: boolean
  /** The provider refused the credential (401/403). False when it could not be reached. */
  rejected: boolean
  /** The provider could not be reached or failed; false when it answered and the input is what is wrong. */
  unavailable: boolean
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

const ok = (account: string | null, expiresAt: string | null = null): Validation => ({ ok: true, rejected: false, unavailable: false, account, expiresAt, message: null })
const refused = (message: string): Validation => ({ ok: false, rejected: true, unavailable: false, account: null, expiresAt: null, message })
const unreachable = (message: string): Validation => ({ ok: false, rejected: false, unavailable: true, account: null, expiresAt: null, message })
const badInput = (message: string): Validation => ({ ok: false, rejected: false, unavailable: false, account: null, expiresAt: null, message })

/** Checks the credential straight against the provider; nothing goes to Altimate. */
export async function validate(id: ProviderId, variant: string, v: Record<string, string>): Promise<Validation> {
  const name = core.PROVIDER_NAMES[id]
  try {
    if (id === "github") {
      const { res, data } = await request(`${githubApi()}/user`, { headers: { Authorization: `Bearer ${v.github_token}`, Accept: "application/vnd.github+json", "User-Agent": "altimate-code" } })
      // GitHub also answers 403 when it is rate limiting: that says nothing about the token.
      if (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after") || /rate limit/i.test(String(data?.message ?? ""))))
        return unreachable("GitHub is rate limiting requests, try again later")
      if (res.status === 401 || res.status === 403) return refused(`GitHub rejected the token (${res.status})${data?.message ? `: ${data.message}` : ""}`)
      if (!res.ok) return unreachable(`GitHub answered ${res.status}`)
      if (typeof data?.login !== "string" || !data.login) return badInput("GitHub answered without an account, check the token")
      return ok(data.login, parseGithubExpiry(res.headers.get("github-authentication-token-expiration")))
    }
    if (id === "jira") {
      let url: string
      let auth: string
      if (core.isJiraServer(variant)) {
        const base = (v.jiraBaseUrl ?? "").replace(/\/+$/, "")
        const local = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(base)
        if (!/^https:\/\//i.test(base) && !local) return badInput("The Jira base URL must start with https://")
        url = `${base}/rest/api/2/myself`
        auth = `Bearer ${v.jiraPatToken}`
      } else {
        const site = core.normaliseJiraDomain(v.jiraDomain ?? "")
        if (!/^[a-z0-9-]+$/i.test(site)) return badInput(`"${v.jiraDomain}" is not a Jira site name, use the part before .atlassian.net`)
        url = `${jiraCloudBase(site)}/rest/api/3/myself`
        auth = `Basic ${Buffer.from(`${v.jiraEmail}:${v.jiraApiToken}`).toString("base64")}`
      }
      const { res, data } = await request(url, { headers: { Authorization: auth, Accept: "application/json" } })
      if (res.status === 401 || res.status === 403) return refused(`Jira rejected the credentials (${res.status})`)
      if (!res.ok) return unreachable(`Jira answered ${res.status}`)
      const who = data?.emailAddress || data?.displayName || data?.name
      if (typeof who !== "string" || !who) return badInput("Jira answered without an account, check the site")
      return ok(who)
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
  /** Attached to a workspace that is not private, so its members can use the connection. */
  shared?: true
}

export interface CredentialOptions {
  id: ProviderId
  localOnly?: boolean
  /** Requires an existing connection and keeps its sync mode. */
  update?: boolean
  variant?: string
  /** Allows attaching to a linked workspace that is not private, whose members can then use the connection. */
  share?: boolean
  onStep?: (label: string) => void
}

const MANUAL_SOURCE: Source = { kind: "cli", label: "Claude Code" }
const CHANGED_WHILE_CONNECTING = "The connection changed while it was being checked, run it again."

export async function connectCredentials(opts: CredentialOptions): Promise<CredentialResult> {
  const { id } = opts
  const name = core.PROVIDER_NAMES[id]
  const base = { provider: id, account: null, expiresAt: null }
  const rec = core.loadStore().providers[id]
  const local = (r: Omit<CredentialResult, "provider" | "account" | "expiresAt"> & Partial<CredentialResult>): CredentialResult => ({ ...base, ...r })
  // A connection that exists only in the workspace can be updated or moved local too.
  let remoteManaged = false
  // A failed call changes nothing, so it reports where the credential already is: in the workspace, or only here.
  const syncState = (): "synced" | "local" => (rec?.synced || remoteManaged ? "synced" : "local")
  if (!rec?.registered && opts.update) {
    try {
      remoteManaged = await core.managedInWorkspace(id)
    } catch (e) {
      return local({ status: "failed", sync: syncState(), message: `Could not check your workspace for an existing connection: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  if (opts.update && !rec?.registered && !remoteManaged)
    return local({ status: "failed", sync: "local", message: `${name} is not connected yet. Use connect first.`, code: "not_connected" })

  const blocked = core.isBlocked(id)
  const r = await resolve(id, opts.variant ?? (opts.update ? rec?.variant : undefined), Boolean(opts.localOnly) || blocked)
  const missing = r.def.fields.filter((f) => f.required && !r.values[f.name])
  if (missing.length)
    return local({ status: "missing_fields", sync: syncState(), message: [`Missing: ${missing.map((f) => f.label).join(", ")}`, ...missing.map((f) => r.notes[f.name]).filter(Boolean)].join(". "), code: "missing_fields", missing: missing.map((f) => f.name) })

  opts.onStep?.("Testing connection…")
  const check = await validate(id, r.variant, r.values)
  const secretFields = r.def.fields.filter((f) => f.secret).map((f) => f.name)
  // Keep local still works when the provider cannot be reached: the credential is kept, flagged as not verified yet.
  const unverified = !check.ok && !check.rejected && check.unavailable && Boolean(opts.localOnly)
  if (!check.ok && !unverified) {
    if (check.rejected) {
      // The provider refused what was typed: it is not kept, and the connection that was working is left as it was.
      for (const f of secretFields) if (r.origin[f] === "draft") await core.deleteSecret(core.secretKey("draft", id, f))
      // Only a re-test of exactly the stored values (every field, not just the secrets) shows that credential has stopped working.
      if (rec?.registered && secretFields.length && r.variant === rec.variant && r.def.fields.every((f) => !r.values[f.name] || r.origin[f.name] === "stored")) {
        await core.updateStore((store) => {
          // The check ran outside the lock: a record that was replaced since is not the credential that was refused.
          if (core.sameRecord(store.providers[id], rec)) store.providers[id] = { ...store.providers[id], rejected: true, validatedAt: new Date().toISOString() }
        })
      }
    }
    return local({ status: check.rejected ? "rejected" : "failed", sync: syncState(), message: check.message ?? "Could not validate the credentials" })
  }

  const wantSync = opts.localOnly ? false : opts.update ? Boolean(rec?.synced) || remoteManaged : true
  const cfg = wantSync && !blocked ? await core.realConfig() : null
  const handDone = Object.values(r.origin).includes("draft") || Object.values(r.origin).includes("stored")
  const detectedSource = r.detected[0]
  const plain = Object.fromEntries(r.def.fields.filter((f) => !f.secret).map((f) => [f.name, r.values[f.name]]).filter(([, v]) => v))
  const stamp = new Date().toISOString()
  const sameCredential = Boolean(rec?.registered) && secretFields.length > 0 && r.variant === rec?.variant && secretFields.every((f) => !r.values[f] || r.origin[f] === "stored")
  const common = {
    registered: true,
    account: check.ok ? check.account : (rec?.account ?? null),
    variant: r.variant,
    values: plain,
    secretFields,
    validatedAt: check.ok ? stamp : undefined,
    credentialStamp: randomUUID(),
    unverified: !check.ok,
    rejected: false,
    // An offline check learns no expiry; the one already known stays only when the very same credential is being kept.
    expiresAt: check.ok ? check.expiresAt : sameCredential ? rec?.expiresAt : undefined,
    drafts: undefined,
  }
  const record = (synced: boolean, extra: Partial<StoredProvider> = {}) =>
    core.updateStore((store) => {
      store.providers[id] = { ...store.providers[id], ...common, source: handDone || !detectedSource ? MANUAL_SOURCE : detectedSource, synced, updatedAt: stamp, ...extra }
    })
  /** Clears what was entered in the form. What it follows has already happened, so a failure comes back as a note instead of stopping the rest. */
  const clearDrafts = async (): Promise<string | null> => {
    try {
      await discardDraftSecrets(id)
      return null
    } catch (e) {
      return `What was entered could not be cleared from this machine: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  if (!cfg) {
    // Keeping a connection local moves it: the whole decision and move happen in one locked step with the uploads, so no workspace copy can appear after it was looked for.
    return await core.withLock(async (): Promise<CredentialResult> => {
      // The checks above ran outside the lock: a record that was changed since is not the one this was checked against.
      if (!core.sameRecord(core.loadStore().providers[id], rec)) return local({ status: "failed", sync: syncState(), message: CHANGED_WHILE_CONNECTING })
      let detachNote: string | null = null
      let removeFailure: string | null = null
      const wasBlocked = core.isBlocked(id)
      const signedIn = await core.realConfig()
      let hadCopy = Boolean(core.loadStore().providers[id]?.synced) || remoteManaged
      if (opts.localOnly && signedIn && !hadCopy) {
        try {
          hadCopy = await core.managedInWorkspace(id)
        } catch (e) {
          return local({ status: "failed", sync: syncState(), message: `Could not check your workspace for an existing connection: ${e instanceof Error ? e.message : String(e)}` })
        }
      }
      if (hadCopy && !signedIn && !core.mockMode())
        return local({ status: "failed", sync: "synced", message: `${name} is saved in your workspace. Sign in to Altimate first.` })
      if (opts.localOnly && !wasBlocked) await core.setBlocked([id], true)
      // The local copy is made durable before the workspace copy is touched, so a failed write never leaves the credential nowhere.
      // A write that fails part way puts back every secret this attempt touched and leaves the previous record as it was.
      const written = new Set<string>()
      const undo: [string, string | undefined][] = []
      const put = async (key: string, value: string) => {
        undo.push([key, await core.readSecret(key)])
        await core.storeSecret(key, value)
      }
      try {
        for (const f of secretFields) if (r.values[f]) {
          await put(core.secretKey("cred", id, f), r.values[f])
          written.add(f)
        }
        if (secretFields[0] && r.values[secretFields[0]]) await put(id, r.values[secretFields[0]])
      } catch (e) {
        for (const [key, prev] of undo.reverse()) {
          try {
            if (prev === undefined) await core.deleteSecret(key)
            else await core.storeSecret(key, prev)
          } catch {}
        }
        if (opts.localOnly && !wasBlocked) await core.setBlocked([id], false)
        return local({ status: "failed", sync: hadCopy ? "synced" : "local", message: e instanceof Error ? e.message : String(e) })
      }
      // Switching variant must not leave the other variant's stored secret behind; only the old fields not just written are purged.
      // A failed purge only leaves the old variant's secrets behind, so the record is still saved and the leftover is reported.
      let purgeNote: string | null = null
      try {
        await core.purgeCredentialSecrets(id, rec, false, written)
      } catch (e) {
        purgeNote = `The previous credential could not be removed from this machine: ${e instanceof Error ? e.message : String(e)}`
      }
      await record(false, { connectionId: null })
      // A draft left behind does not stop the move: the workspace copy is still removed below.
      const draftNote = await clearDrafts()
      if (signedIn && hadCopy) {
        try {
          detachNote = (await core.removeManaged(id, signedIn)).detachError
        } catch (e) {
          removeFailure = e instanceof Error ? e.message : String(e)
        }
      }
      if (hadCopy && !signedIn) await core.removeMockRemote(id)
      const notSignedIn = wantSync && !blocked
      const notes = [
        removeFailure ? "The credential is kept on this machine, but the workspace copy is still there." : null,
        purgeNote,
        draftNote,
        unverified ? `${check.message} (kept on this machine, not verified yet)` : null,
        notSignedIn ? core.NOT_SIGNED_IN : blocked && wantSync ? "Sync is blocked for this provider, kept local." : null,
        removeFailure ? core.REMOVE_FAILED_WARNING(removeFailure).trim() : null,
        detachNote ? `Could not detach it from the linked workspace: ${detachNote}` : null,
      ].filter(Boolean)
      // A workspace copy that could not be removed means the move is not done: it is reported as failed, and connecting again with --local-only retries the removal.
      return { ...base, provider: id, status: removeFailure ? "failed" : "connected", sync: removeFailure ? "synced" : "local", account: common.account ?? null, expiresAt: common.expiresAt ?? null, message: notes.length ? notes.join(" ") : null }
    })
  }

  opts.onStep?.("Saving to your workspace…")
  const config: Record<string, unknown> = {}
  for (const f of r.def.fields) if (r.values[f.name]) config[f.name] = r.values[f.name]
  if (check.expiresAt) config.expires_at = check.expiresAt
  // Set once the upload is done, so a later failure still says who can already use the connection.
  let exposure: { notes: string[]; shared: boolean } = { notes: [], shared: false }
  try {
    // The blocked check and the upload share one lock with Keep local, so a move to this machine cannot interleave with an upload.
    return await core.withLock(async (): Promise<CredentialResult> => {
      if (!core.sameRecord(core.loadStore().providers[id], rec)) return local({ status: "failed", sync: syncState(), message: CHANGED_WHILE_CONNECTING })
      if (core.isBlocked(id)) return local({ status: "failed", sync: syncState(), message: "Sync is blocked for this provider, kept local." })
      const res = await core.upsertManaged(cfg, id, core.withVariant(id, r.variant, config), opts.share === true, opts.update ? "update" : "connect")
      exposure = core.exposureNotes(res)
      if (!res.isValid) {
        const rejected = (sync: "synced" | "local"): CredentialResult => ({ ...base, provider: id, status: "rejected", sync, account: check.account, expiresAt: common.expiresAt ?? null, message: core.rejectionMessage(res) + (res.shared ? ` ${core.SHARED_REWRITE_NOTE}` : ""), ...(res.shared ? { shared: true as const } : {}) })
        // An existing connection was updated in place and cannot be reverted, so it stays marked rejected for update to fix; the local copy of a local credential is untouched.
        if (!res.created && !(rec?.registered && !rec.synced)) {
          await record(true, { connectionId: res.connectionId, rejected: true })
          const draftNote = await clearDrafts()
          const refusal = rejected("synced")
          return draftNote ? { ...refusal, message: `${refusal.message} ${draftNote}` } : refusal
        }
        // A new connection the workspace refuses is removed again and nothing is stored.
        let warning = ""
        if (res.created) {
          try {
            await backend.deleteConnection(cfg, res.connectionId)
          } catch (e) {
            warning = core.REMOVE_FAILED_WARNING(e instanceof Error ? e.message : String(e))
          }
        }
        const draftNote = await clearDrafts()
        const refusal = rejected(rec?.synced ? "synced" : "local")
        return { ...refusal, message: [(refusal.message ?? "") + warning, draftNote].filter(Boolean).join(" ") }
      }
      // The connection lives in the workspace and was accepted; no secret is kept on this machine.
      // The record is saved first: the workspace has the connection, so a cleanup that fails afterwards is reported, not turned into a failed connect.
      try {
        await record(true, { connectionId: res.connectionId })
      } catch (e) {
        return { ...base, provider: id, status: "failed", sync: "synced", account: check.account, expiresAt: common.expiresAt ?? null, message: [core.RECORD_WRITE_FAILED(e instanceof Error ? e.message : String(e), "Connect again"), ...exposure.notes].join(" "), ...(exposure.shared ? { shared: true as const } : {}) }
      }
      let leftover: string | null = null
      try {
        await core.purgeCredentialSecrets(id, rec, false)
        await core.deleteSecret(id)
        await discardDraftSecrets(id)
      } catch (e) {
        leftover = `Saved to the workspace, but the local copy of the credential could not be removed: ${e instanceof Error ? e.message : String(e)}`
      }
      const sharedNote = res.shared ? `Updated the shared connection${core.SHARED_CONNECTION_AUDIENCE}.` : null
      const message = [sharedNote, workspaceNote(res.workspace), leftover].filter(Boolean).join(" ") || null
      const shared = res.shared || (res.workspace && "attached" in res.workspace && res.workspace.shared) ? { shared: true as const } : {}
      return { ...base, provider: id, status: "connected", sync: "synced", account: check.account, expiresAt: common.expiresAt ?? null, message, ...shared }
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (exposure.shared) return { ...local({ status: "failed", sync: syncState(), message: [message, ...exposure.notes].join(" ") }), shared: true }
    return local({ status: "failed", sync: syncState(), message })
  }
}

function workspaceNote(w: core.UpsertResult["workspace"]): string | null {
  if (!w) return null
  if ("error" in w) return core.ATTACH_FAILED_PREFIX + w.error
  if ("notLinked" in w) return core.NOT_LINKED_LABEL
  const where = workspaceLabel(w.attached, w.workspaceId)
  const audience = w.shared ? core.SHARED_AUDIENCE : ""
  return `${w.kept ? `Kept the workspace's existing connection in ${where}` : `Attached to ${where}`}${audience}`
}

export * as IntegrationsCredentials from "./credentials"
