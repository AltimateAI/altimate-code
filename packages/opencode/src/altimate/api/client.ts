import z from "zod"
import path from "path"
import os from "os"
import fs from "fs"
import { Global } from "../../global"
import { Filesystem } from "../../util/filesystem"

// altimate_change start — PROTO_FRESH: sandbox all credential I/O to a throwaway
// temp dir, cleared once at startup, so demos start credential-free and never
// read or write the user's real ~/.altimate files. No effect unless PROTO_FRESH=1.
const PROTO_FRESH_SANDBOX = process.env.PROTO_FRESH === "1" ? path.join(os.tmpdir(), "altimate-proto-fresh") : null
if (PROTO_FRESH_SANDBOX) {
  try {
    fs.rmSync(path.join(PROTO_FRESH_SANDBOX, "altimate"), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}
// altimate_change end

const DEFAULT_MCP_URL = "https://mcpserver.getaltimate.com/sse"
// altimate_change start — default Altimate API URL when user omits it from the TUI credential entry
const DEFAULT_ALTIMATE_URL = "https://api.myaltimate.com"
// altimate_change end

const AltimateCredentials = z.object({
  altimateUrl: z.string(),
  altimateInstanceName: z.string(),
  altimateApiKey: z.string(),
  mcpServerUrl: z.string().optional(),
})
type AltimateCredentials = z.infer<typeof AltimateCredentials>

const DatamateSummary = z.object({
  id: z.coerce.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  integrations: z
    .array(
      z.object({
        id: z.coerce.string(),
        tools: z.array(z.object({ key: z.string() })).optional(),
      }),
    )
    .nullable()
    .optional(),
  memory_enabled: z.boolean().optional(),
  privacy: z.string().optional(),
})

const IntegrationSummary = z.object({
  id: z.coerce.string(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  tools: z
    .array(
      z.object({
        key: z.string(),
        name: z.string().optional(),
        enable_all: z.array(z.string()).optional(),
      }),
    )
    .optional(),
})

export namespace AltimateApi {
  export function credentialsPath(): string {
    // altimate_change start — PROTO_FRESH sandbox
    if (PROTO_FRESH_SANDBOX) return path.join(PROTO_FRESH_SANDBOX, "altimate", "altimate.json")
    // altimate_change end
    return path.join(Global.Path.home, ".altimate", "altimate.json")
  }

  export async function isConfigured(): Promise<boolean> {
    return Filesystem.exists(credentialsPath())
  }

  function resolveEnvVars(obj: unknown): unknown {
    if (typeof obj === "string") {
      return obj.replace(/\$\{env:([^}]+)\}/g, (_, envVar) => {
        const value = process.env[envVar]
        if (value === undefined) throw new Error(`Environment variable ${envVar} not found`)
        return value
      })
    }
    if (Array.isArray(obj)) return obj.map(resolveEnvVars)
    if (obj && typeof obj === "object")
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveEnvVars(v)]))
    return obj
  }

  export async function getCredentials(): Promise<AltimateCredentials> {
    const p = credentialsPath()
    if (!(await Filesystem.exists(p))) {
      throw new Error(`Altimate credentials not found at ${p}`)
    }
    const raw = resolveEnvVars(JSON.parse(await Filesystem.readText(p)))
    const creds = AltimateCredentials.parse(raw)
    return {
      ...creds,
      altimateUrl: creds.altimateUrl.replace(/\/+$/, ""),
    }
  }

  /**
   * Parse a user-entered Altimate credential string into its component fields.
   *
   * Accepts two `::`-delimited forms:
   *   - 2 parts: `instance-name::api-key` — URL defaults to {@link DEFAULT_ALTIMATE_URL}.
   *   - 3+ parts: `api-url::instance-name::api-key` — first segment is the API base URL
   *     and must be http(s)://. Extra `::` segments are joined back into the API key.
   *
   * Returns `null` if the input is malformed (fewer than 2 parts, empty fields,
   * or a non-http(s) URL in the 3-part form).
   */
  export function parseAltimateKey(value: string): {
    altimateUrl: string
    altimateInstanceName: string
    altimateApiKey: string
  } | null {
    const parts = value.trim().split("::")
    // altimate_change start — 2 parts means no URL was given (use default); 3+ parts means URL was given
    if (parts.length < 2) return null
    let url: string
    let instance: string
    let key: string
    if (parts.length === 2) {
      url = DEFAULT_ALTIMATE_URL
      instance = parts[0].trim()
      key = parts[1].trim()
    } else {
      url = parts[0].trim()
      instance = parts[1].trim()
      key = parts.slice(2).join("::").trim()
    }
    if (!url || !instance || !key) return null
    if (!url.startsWith("http://") && !url.startsWith("https://")) return null
    // altimate_change end
    return { altimateUrl: url, altimateInstanceName: instance, altimateApiKey: key }
  }

  export async function saveCredentials(creds: {
    altimateUrl: string
    altimateInstanceName: string
    altimateApiKey: string
    mcpServerUrl?: string
  }): Promise<void> {
    await Filesystem.writeJson(
      credentialsPath(),
      { ...creds, altimateUrl: creds.altimateUrl.replace(/\/+$/, "") },
      0o600,
    )
  }

  const VALID_TENANT_REGEX = /^[a-z_][a-z0-9_-]*$/

  /** Validates credentials against the Altimate API.
   *  Mirrors AltimateSettingsHelper.validateSettings from altimate-mcp-engine. */
  export async function validateCredentials(creds: {
    altimateUrl: string
    altimateInstanceName: string
    altimateApiKey: string
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!VALID_TENANT_REGEX.test(creds.altimateInstanceName)) {
      return {
        ok: false,
        error:
          "Invalid instance name (must be lowercase letters, numbers, underscores, hyphens, starting with letter or underscore)",
      }
    }
    try {
      const url = `${creds.altimateUrl.replace(/\/+$/, "")}/dbt/v3/validate-credentials`
      // altimate_change start — upstream_fix: add timeout to prevent indefinite hang on network issues
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      // altimate_change end
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "x-tenant": creds.altimateInstanceName,
          Authorization: `Bearer ${creds.altimateApiKey}`,
          "Content-Type": "application/json",
        },
        // altimate_change start — upstream_fix: attach abort signal
        signal: controller.signal,
        // altimate_change end
      }).finally(() => clearTimeout(timeout))
      if (res.status === 401) {
        const body = await res.text()
        return { ok: false, error: `Invalid API key - ${body}` }
      }
      if (res.status === 403) {
        const body = await res.text()
        return { ok: false, error: `Invalid instance name - ${body}` }
      }
      if (!res.ok) {
        return { ok: false, error: `Connection failed (${res.status} ${res.statusText})` }
      }
      return { ok: true }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Could not reach Altimate API: ${detail}` }
    }
  }

  // altimate_change start — prototype gateway device flow (Part 1 onboarding).
  // Talks to the stub server (or the real backend) using the SAME wire contract
  // as packages/opencode/src/account/index.ts: a standard OAuth device grant,
  // then bearer-authenticated follow-ups for the account + instance. Everything
  // here is real CLI code; only the endpoints it targets are stubbed locally.

  const GATEWAY_CLIENT_ID = "opencode-cli"

  /** Resolved gateway base URL. `ALTIMATE_BASE_URL` overrides the default so the
   *  CLI can point at the local stub; default behavior is unchanged. */
  export function gatewayBaseUrl(): string {
    return (process.env.ALTIMATE_BASE_URL ?? DEFAULT_ALTIMATE_URL).replace(/\/+$/, "")
  }

  export interface GatewayDeviceAuth {
    deviceCode: string
    userCode: string
    verificationUrl: string
    intervalMs: number
    expiresInMs: number
  }

  export async function gatewayStartDevice(): Promise<GatewayDeviceAuth> {
    const base = gatewayBaseUrl()
    const res = await fetch(`${base}/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: GATEWAY_CLIENT_ID }),
    })
    if (!res.ok) throw new Error(`Could not start sign-in (${res.status} ${res.statusText})`)
    const d = (await res.json()) as {
      device_code: string
      user_code: string
      verification_uri_complete: string
      interval?: number
      expires_in?: number
    }
    return {
      deviceCode: d.device_code,
      userCode: d.user_code,
      verificationUrl: `${base}${d.verification_uri_complete}`,
      intervalMs: (d.interval ?? 2) * 1000,
      expiresInMs: (d.expires_in ?? 900) * 1000,
    }
  }

  export type GatewayPoll =
    | { status: "pending" }
    | { status: "slow_down" }
    | { status: "expired" }
    | { status: "denied" }
    | { status: "authorized"; accessToken: string; refreshToken: string }

  export async function gatewayPollToken(deviceCode: string): Promise<GatewayPoll> {
    const res = await fetch(`${gatewayBaseUrl()}/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: GATEWAY_CLIENT_ID,
      }),
    })
    const d = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      error?: string
    }
    if (d.access_token) return { status: "authorized", accessToken: d.access_token, refreshToken: d.refresh_token ?? "" }
    switch (d.error) {
      case "authorization_pending":
        return { status: "pending" }
      case "slow_down":
        return { status: "slow_down" }
      case "access_denied":
        return { status: "denied" }
      default:
        return { status: "expired" }
    }
  }

  export interface GatewayUser {
    email: string
    suggestedInstance: string
  }

  export async function gatewayGetUser(accessToken: string): Promise<GatewayUser> {
    const res = await fetch(`${gatewayBaseUrl()}/api/user`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    })
    if (!res.ok) throw new Error(`Could not load your account (${res.status})`)
    const d = (await res.json()) as { email?: string; suggested_instance?: string }
    return { email: d.email ?? "", suggestedInstance: d.suggested_instance ?? "" }
  }

  export type GatewayInstanceCreate = "provisioning" | "name_taken" | "invalid_name"

  export async function gatewayCreateInstance(accessToken: string, name: string): Promise<GatewayInstanceCreate> {
    const res = await fetch(`${gatewayBaseUrl()}/api/instance`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
    if (res.status === 201) return "provisioning"
    if (res.status === 409) return "name_taken"
    return "invalid_name"
  }

  export type GatewayInstancePoll =
    | { status: "provisioning" }
    | { status: "ready"; instance: string; apiKey: string }

  export async function gatewayPollInstance(accessToken: string): Promise<GatewayInstancePoll> {
    const res = await fetch(`${gatewayBaseUrl()}/api/instance`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    })
    const d = (await res.json()) as { status?: string; instance?: string; api_key?: string }
    if (d.status === "ready" && d.api_key) return { status: "ready", instance: d.instance ?? "", apiKey: d.api_key }
    return { status: "provisioning" }
  }

  // --- BYOK validation layers (Part 1 onboarding) -------------------------------
  // Two stages after a key/code is submitted (the auth-method screens themselves
  // are unchanged): stage 1 is a cheap auth ping, stage 2 a minimal forced tool
  // call. PROTO_FAKE_VALIDATION=pass|fail_key|fail_tools makes both deterministic
  // for demos: the failing stage fails the FIRST attempt per provider, then passes
  // (so the recover -> retry -> pass demo path works without changing env).

  export type ByokValidation = { ok: true } | { ok: false; error: string }

  const fakeAttempts = new Map<string, number>()

  function fakeMode(): string | undefined {
    const v = process.env.PROTO_FAKE_VALIDATION
    return v === "pass" || v === "fail_key" || v === "fail_tools" ? v : undefined
  }

  /** Fire-and-forget structured event to the local stub (instrumentation demo). */
  export function protoEvent(event: string, data: Record<string, unknown> = {}): void {
    if (!process.env.ALTIMATE_BASE_URL) return
    fetch(`${gatewayBaseUrl()}/dev/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, ...data }),
    }).catch(() => {})
  }

  /** Stage 1 — cheap auth ping. Invalid key can never work, so callers must offer
   *  no "continue anyway" on failure. */
  export async function byokValidateKey(providerID: string, key: string): Promise<ByokValidation> {
    const mode = fakeMode()
    if (mode) {
      const n = (fakeAttempts.get(`key:${providerID}`) ?? 0) + 1
      fakeAttempts.set(`key:${providerID}`, n)
      const ok = mode !== "fail_key" || n > 1
      protoEvent("byok_validation_result", { provider: providerID, stage: "key", result: ok ? "pass" : "fail" })
      return ok ? { ok: true } : { ok: false, error: "The provider rejected this API key (401 Unauthorized)." }
    }
    const result = await stage1Ping(providerID, key)
    protoEvent("byok_validation_result", {
      provider: providerID,
      stage: "key",
      result: result === "unauthorized" ? "fail" : "pass",
    })
    if (result === "unauthorized") return { ok: false, error: "The provider rejected this API key." }
    // Transport errors / unknown providers don't block key entry.
    return { ok: true }
  }

  async function stage1Ping(providerID: string, key: string): Promise<"ok" | "unauthorized" | "unknown"> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      let res: Response | undefined
      if (providerID === "anthropic") {
        res = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
          signal: controller.signal,
        })
      } else if (providerID === "openai") {
        res = await fetch("https://api.openai.com/v1/models", {
          headers: { authorization: `Bearer ${key}` },
          signal: controller.signal,
        })
      } else if (providerID === "google") {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
          signal: controller.signal,
        })
      }
      if (!res) return "unknown"
      if (res.status === 401 || res.status === 403) return "unauthorized"
      if (providerID === "google" && res.status === 400) return "unauthorized"
      return "ok"
    } catch {
      return "unknown"
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Stage 2 — tool-calling validation (key already valid). */
  export async function byokValidateTools(providerID: string): Promise<ByokValidation> {
    const mode = fakeMode()
    if (mode) {
      const n = (fakeAttempts.get(`tools:${providerID}`) ?? 0) + 1
      fakeAttempts.set(`tools:${providerID}`, n)
      const ok = mode !== "fail_tools" || n > 1
      protoEvent("byok_validation_result", { provider: providerID, stage: "tools", result: ok ? "pass" : "fail" })
      return ok
        ? { ok: true }
        : { ok: false, error: "The key is valid, but the model failed a minimal forced tool call." }
    }
    // Real stage-2 needs a live model round-trip (one minimal forced tool call);
    // the prototype treats reachable providers as pass when not faked.
    protoEvent("byok_validation_result", { provider: providerID, stage: "tools", result: "pass" })
    return { ok: true }
  }
  // altimate_change end

  async function request(creds: AltimateCredentials, method: string, endpoint: string, body?: unknown) {
    const url = `${creds.altimateUrl}${endpoint}`
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.altimateApiKey}`,
        "x-tenant": creds.altimateInstanceName,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      throw new Error(`API ${method} ${endpoint} failed with status ${res.status}`)
    }
    return res.json()
  }

  export async function listDatamates() {
    const creds = await getCredentials()
    const data = await request(creds, "GET", "/datamates/")
    const list = Array.isArray(data) ? data : (data.datamates ?? data.data ?? [])
    return list.map((d: unknown) => DatamateSummary.parse(d)) as z.infer<typeof DatamateSummary>[]
  }

  export async function getDatamate(id: string) {
    const creds = await getCredentials()
    try {
      const data = await request(creds, "GET", `/datamates/${id}/summary`)
      const raw = data.datamate ?? data
      return DatamateSummary.parse(raw)
    } catch (e) {
      // Fallback to list if single-item endpoint is unavailable (404)
      if (e instanceof Error && e.message.includes("status 404")) {
        const all = await listDatamates()
        const found = all.find((d) => d.id === id)
        if (!found) {
          throw new Error(`Datamate with ID ${id} not found`)
        }
        return found
      }
      throw e
    }
  }

  export async function createDatamate(payload: {
    name: string
    description?: string
    integrations?: Array<{ id: string; tools: Array<{ key: string }> }>
    memory_enabled?: boolean
    privacy?: string
  }) {
    const creds = await getCredentials()
    const data = await request(creds, "POST", "/datamates/", payload)
    // Backend returns { id: number } for create
    const id = String(data.id ?? data.datamate?.id)
    return { id, name: payload.name }
  }

  export async function updateDatamate(
    id: string,
    payload: {
      name?: string
      description?: string
      integrations?: Array<{ id: string; tools: Array<{ key: string }> }>
      memory_enabled?: boolean
      privacy?: string
    },
  ) {
    const creds = await getCredentials()
    const data = await request(creds, "PATCH", `/datamates/${id}`, payload)
    const raw = data.datamate ?? data
    return DatamateSummary.parse(raw)
  }

  export async function deleteDatamate(id: string) {
    const creds = await getCredentials()
    await request(creds, "DELETE", `/datamates/${id}`)
  }

  export async function listIntegrations() {
    const creds = await getCredentials()
    const data = await request(creds, "GET", "/datamate_integrations/")
    const list = Array.isArray(data) ? data : (data.integrations ?? data.data ?? [])
    return list.map((d: unknown) => IntegrationSummary.parse(d)) as z.infer<typeof IntegrationSummary>[]
  }

  /** Resolve integration IDs to full integration objects with all tools enabled (matching frontend behavior). */
  export async function resolveIntegrations(
    integrationIds: string[],
  ): Promise<Array<{ id: string; tools: Array<{ key: string }> }>> {
    const allIntegrations = await listIntegrations()
    return integrationIds.map((id) => {
      const def = allIntegrations.find((i) => i.id === id)
      const tools =
        def?.tools?.flatMap((t) => (t.enable_all ?? [t.key]).map((k) => ({ key: k }))) ?? []
      return { id, tools }
    })
  }

  export function buildMcpConfig(creds: AltimateCredentials, datamateId: string) {
    return {
      type: "remote" as const,
      url: creds.mcpServerUrl ?? DEFAULT_MCP_URL,
      oauth: false as const,
      headers: {
        Authorization: `Bearer ${creds.altimateApiKey}`,
        "x-datamate-id": String(datamateId),
        "x-tenant": creds.altimateInstanceName,
        "x-altimate-url": creds.altimateUrl,
      },
    }
  }
}
