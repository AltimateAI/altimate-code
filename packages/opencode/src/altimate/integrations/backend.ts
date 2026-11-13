// altimate_change - new file
//
// Client for the workspace connections API of the Altimate backend: list, create, update and delete
// the caller's own connections, plus the integrations catalog. Credentials come from the existing
// Altimate login; the integrations-only environment variables point this client at another backend.
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
  /** Who besides the owner can use it; anything but "private" (or none) counts as shared. */
  privacy?: string
}

/** The login used for backend calls, or null when there is none. */
export async function backendConfig(): Promise<BackendConfig | null> {
  const env = { url: process.env.ALTIMATE_INTEGRATIONS_API_URL, tenant: process.env.ALTIMATE_INTEGRATIONS_TENANT, token: process.env.ALTIMATE_INTEGRATIONS_TOKEN }
  if (env.url && env.tenant && env.token) return { apiUrl: env.url.replace(/\/+$/, ""), tenant: env.tenant, token: env.token }
  const creds = await AltimateApi.getCredentials().catch((e) => {
    if (e instanceof Error && /credentials not found/i.test(e.message)) return null
    throw new Error(`Could not read your Altimate login (${e instanceof Error ? e.message : e}). Fix or remove the credentials file, then sign in again.`)
  })
  const apiUrl = (creds?.altimateUrl || "").replace(/\/+$/, "")
  const token = creds?.altimateApiKey || ""
  const tenant = creds?.altimateInstanceName || ""
  if (!apiUrl || !token || !tenant) return null
  return { apiUrl, tenant, token }
}

/** The entries of a catalog response: a bare list, or one wrapped in `items`, `integrations` or `data`. */
export function catalogEntries(data: unknown): any[] {
  const list = Array.isArray(data) ? data : isObject(data) ? (data.items ?? data.integrations ?? data.data ?? []) : []
  return Array.isArray(list) ? list : []
}

const FAILURE_TEXT: Record<number, string> = {
  400: "The request was rejected",
  404: "The requested resource was not found",
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
    let unreadable = false
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      unreadable = true
    }
    // A success that cannot be read is not an empty answer: an empty list would read as "no connections".
    if (res.ok && unreadable) throw new BackendError(`The Altimate API answered ${res.status} with a body that is not JSON`, res.status, null)
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

/** Every connection the caller can see, their own and those shared with them. */
export async function listVisibleConnections(cfg: BackendConfig): Promise<Connection[]> {
  return connectionList(await call<{ connections?: Connection[] }>(cfg, "GET", "/connections/?include_shared=true"))
}
/** The list in a connections answer. An answer without one is an error: an empty list would read as "no connections". */
function connectionList(res: { connections?: Connection[] } | null): Connection[] {
  if (!Array.isArray(res?.connections)) throw new BackendError("The Altimate API answered without a list of connections", 200, null)
  return res.connections
}
/** The caller's own connections only: nothing shared with them. */
export const ownConnections = (all: Connection[]): Connection[] => all.filter((c) => c.is_owner !== false)
export async function listOwnConnections(cfg: BackendConfig): Promise<Connection[]> {
  return ownConnections(connectionList(await call<{ connections?: Connection[] }>(cfg, "GET", "/connections/?include_shared=false")))
}
export const createConnection = (cfg: BackendConfig, body: { name: string; integration_id: string; config: Record<string, unknown> }) =>
  call<Connection>(cfg, "POST", "/connections/", body)
export const updateConnection = (cfg: BackendConfig, id: number, body: { config: Record<string, unknown> }) =>
  call<Connection>(cfg, "PATCH", `/connections/${id}`, body)
export const deleteConnection = (cfg: BackendConfig, id: number) => call<unknown>(cfg, "DELETE", `/connections/${id}`)
/** The workspace integrations catalog: what each provider's web form asks for. */
export const integrationsCatalog = (cfg: BackendConfig) => call<unknown>(cfg, "GET", "/datamate_integrations/")

/** One integration entry of a workspace, as the datamates API stores it. */
export interface DatamateIntegrationEntry {
  id: string
  tools: Array<{ key: string }>
  connection_id?: string | number | null
  connection_ids?: string[] | null
  [extra: string]: unknown
}
export interface DatamateRecord {
  id: string
  name: string
  integrations: DatamateIntegrationEntry[]
  /** False when the caller is not the workspace's owner: only the owner can change its integrations. */
  is_owner?: boolean
  /** "private" keeps an attached connection to its owner; any other value lets the workspace's members use it. */
  privacy?: string
}

/** A workspace with its integrations list. */
export async function getDatamate(cfg: BackendConfig, id: string): Promise<DatamateRecord> {
  let d: any
  try {
    const res = await call<any>(cfg, "GET", `/datamates/${encodeURIComponent(id)}/summary`)
    d = res?.datamate ?? res
  } catch (e) {
    if (!(e instanceof BackendError) || e.status !== 404) throw e
    // A backend without the summary route still lists its workspaces. The integrations list is replaced whole, so a listed workspace without one is not trusted.
    const res = await call<any>(cfg, "GET", "/datamates/")
    const all = Array.isArray(res) ? res : (res?.datamates ?? res?.data ?? [])
    d = Array.isArray(all) ? all.find((x: any) => String(x?.id) === id) : undefined
    if (!d) throw e
    if (!Array.isArray(d.integrations)) throw new BackendError("The Altimate API listed the workspace without its integrations", 200, null)
  }
  // An answer that is not a workspace record is an error: building the next list from it could drop the workspace's integrations.
  if (!isObject(d) || (d.id == null && d.name == null && !("integrations" in d))) throw new BackendError("The Altimate API answered without the workspace record", 200, null)
  // The list is required in the workspace record and written back whole, so a missing or null one is as malformed as a non-list.
  if (!Array.isArray(d.integrations)) throw new BackendError("The Altimate API answered with workspace integrations that are not a list", 200, null)
  return { ...d, id: String(d.id ?? id), name: d.name ?? "", integrations: d.integrations }
}
/** Replaces the workspace's whole integrations list. */
export const updateDatamateIntegrations = (cfg: BackendConfig, id: string, integrations: DatamateIntegrationEntry[]) =>
  call<unknown>(cfg, "PATCH", `/datamates/${encodeURIComponent(id)}`, { integrations })

export * as IntegrationsBackend from "./backend"
