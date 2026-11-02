// altimate_change - new file
//
// Client for the workspace connections API of the Altimate backend: list, create, update and delete
// the caller's own connections, plus the integrations catalog. Credentials come from the existing
// Altimate login, with environment overrides for local development.
import { AltimateApi } from "../api/client"

export interface BackendConfig {
  apiUrl: string
  tenant: string
  token: string
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message)
    this.name = "BackendError"
  }
}

/** A connection as the connections API returns it. */
export interface Connection {
  id: number
  name: string
  integration_id: string
  config?: Record<string, unknown>
  is_valid: boolean
  last_validated_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  is_owner?: boolean
}

/** The login used for backend calls, or null when there is none. */
export async function backendConfig(): Promise<BackendConfig | null> {
  const creds = await AltimateApi.getCredentials().catch(() => null)
  const apiUrl = (process.env.ALTIMATE_API_URL || creds?.altimateUrl || "").replace(/\/+$/, "")
  const token = process.env.ALTIMATE_TOKEN || creds?.altimateApiKey || ""
  const tenant = process.env.ALTIMATE_TENANT || creds?.altimateInstanceName || ""
  if (!apiUrl || !token || !tenant) return null
  return { apiUrl, tenant, token }
}

const FAILURE_TEXT: Record<number, string> = {
  400: "The request was rejected",
  404: "The connection was not found",
  409: "The saved credential changed, reload and try again",
  422: "The connection details were not accepted",
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)

/** The backend's error code: `detail.code`, or the type of the first validation error. */
export function failureCode(data: any): string | null {
  const detail = data?.detail ?? data
  if (Array.isArray(detail)) {
    const first = detail.find(isObject)
    return typeof first?.type === "string" ? first.type : null
  }
  return typeof detail?.code === "string" ? detail.code : null
}

/** The backend's own message and code when it sends them, so the user sees why a call failed. */
export function describeFailure(status: number, data: any): string {
  const detail = data?.detail ?? data
  const code = failureCode(data)
  const listed = Array.isArray(detail) ? detail.filter(isObject).map((e) => (typeof e.msg === "string" ? e.msg : "")).filter(Boolean) : []
  const text = listed.length
    ? listed.join("; ")
    : typeof detail?.message === "string" && detail.message
      ? detail.message
      : typeof detail === "string" && detail
        ? detail
        : (FAILURE_TEXT[status] ?? `status ${status}`)
  return code ? `${text} (${code})` : text
}

async function call<T>(cfg: BackendConfig, method: string, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(`${cfg.apiUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
        "x-tenant": cfg.tenant,
        ...AltimateApi.clientHeaders(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {}
    if (!res.ok) {
      throw new BackendError(describeFailure(res.status, data), res.status, failureCode(data))
    }
    return data as T
  } catch (e) {
    if (e instanceof BackendError) throw e
    throw new BackendError(`Could not reach the Altimate API: ${e instanceof Error ? e.message : String(e)}`, 0, null)
  } finally {
    clearTimeout(timer)
  }
}

/** The caller's own connections only: nothing shared with them. */
export async function listOwnConnections(cfg: BackendConfig): Promise<Connection[]> {
  const res = await call<{ connections?: Connection[] }>(cfg, "GET", "/connections/?include_shared=false")
  return (res?.connections ?? []).filter((c) => c.is_owner !== false)
}
export const createConnection = (cfg: BackendConfig, body: { name: string; integration_id: string; config: Record<string, unknown> }) =>
  call<Connection>(cfg, "POST", "/connections/", body)
export const updateConnection = (cfg: BackendConfig, id: number, body: { config: Record<string, unknown> }) =>
  call<Connection>(cfg, "PATCH", `/connections/${id}`, body)
export const deleteConnection = (cfg: BackendConfig, id: number) => call<unknown>(cfg, "DELETE", `/connections/${id}`)
/** The workspace integrations catalog: what each provider's web form asks for. */
export const integrationsCatalog = (cfg: BackendConfig) => call<unknown>(cfg, "GET", "/datamate_integrations/")
