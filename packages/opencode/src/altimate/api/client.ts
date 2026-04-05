import z from "zod"
import path from "path"
import { Global } from "../../global"
import { Filesystem } from "../../util/filesystem"

const DEFAULT_MCP_URL = "https://mcpserver.getaltimate.com/sse"

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

  export function parseAltimateKey(value: string): {
    altimateUrl: string
    altimateInstanceName: string
    altimateApiKey: string
  } | null {
    const parts = value.trim().split("::")
    if (parts.length < 3) return null
    const url = parts[0].trim()
    const instance = parts[1].trim()
    const key = parts.slice(2).join("::").trim()
    if (!url || !instance || !key) return null
    if (!url.startsWith("http://") && !url.startsWith("https://")) return null
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
