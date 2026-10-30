// altimate_change - new file
//
// Client for the integrations endpoints of the Altimate backend: OAuth start and exchange, the
// connection sync and the per-user status. Credentials come from the existing Altimate login, with
// environment overrides for local development.
import { AltimateApi } from "../api/client"
import { resolveWorkspaceWebUrl } from "../workspace/browser-handoff"

export interface BackendConfig {
  apiUrl: string
  tenant: string
  token: string
  frontendUrl: string | null
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

export interface StartRequest {
  redirect_uri: string
  client_state: string
  save_to_workspace: boolean
  connection_id: number | null
}
export interface StartResponse {
  authorize_url: string
  state_expires_in: number
}
export interface ExchangeResponse {
  provider: string
  account: string | null
  site_url: string | null
  expires_at: string | null
  saved: boolean
  connection_id: number | null
  access_token: string | null
}
export interface SyncRequest {
  integration_id: string
  config: Record<string, unknown>
  source: { kind: "cli" | "env" | "mcp"; label: string; machine: string }
}
export interface SyncResponse {
  connection_id: number
  created: boolean
  is_valid: boolean
  message: string | null
}
export interface RemoteProvider {
  integration_id: string
  connection_id: number | null
  name: string
  account: string | null
  auth_type: "oauth" | "token" | null
  source: { kind?: string; label?: string } | string | null
  expires_at: string | null
  expired: boolean
  is_valid: boolean | null
}

/** The login used for backend calls, or null when there is none. */
export async function backendConfig(): Promise<BackendConfig | null> {
  const creds = await AltimateApi.getCredentials().catch(() => null)
  const apiUrl = (process.env.ALTIMATE_API_URL || creds?.altimateUrl || "").replace(/\/+$/, "")
  const token = process.env.ALTIMATE_TOKEN || creds?.altimateApiKey || ""
  const tenant = process.env.ALTIMATE_TENANT || creds?.altimateInstanceName || ""
  if (!apiUrl || !token || !tenant) return null
  const frontend = process.env.ALTIMATE_FRONTEND_URL || resolveWorkspaceWebUrl(apiUrl, tenant)?.origin || null
  return { apiUrl, tenant, token, frontendUrl: frontend ? frontend.replace(/\/+$/, "") : null }
}

const FAILURE_TEXT: Record<number, string> = {
  400: "The request was rejected",
  409: "The saved access expired, reconnect to continue",
  410: "This sign-in link was already used or expired",
  422: "The credential did not pass the connection test",
  503: "This provider is not set up for the workspace",
}

export function failureCode(data: any): string | null {
  const detail = data?.detail ?? data
  return typeof detail?.code === "string" ? detail.code : null
}

/** The backend's own message and code when it sends them, so the user sees why a call failed. */
export function describeFailure(status: number, data: any): string {
  const detail = data?.detail ?? data
  const code = failureCode(data)
  const text = typeof detail?.message === "string" && detail.message ? detail.message : typeof detail === "string" && detail ? detail : (FAILURE_TEXT[status] ?? `status ${status}`)
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

export const startOAuth = (cfg: BackendConfig, provider: string, body: StartRequest) =>
  call<StartResponse>(cfg, "POST", `/integrations/oauth/${provider}/start`, body)
export const exchangeCode = (cfg: BackendConfig, code: string) =>
  call<ExchangeResponse>(cfg, "POST", "/integrations/oauth/exchange", { code })
export const syncConnection = (cfg: BackendConfig, body: SyncRequest) =>
  call<SyncResponse>(cfg, "POST", "/integrations/connections/sync", body)
export const deleteConnection = (cfg: BackendConfig, id: number) =>
  call<unknown>(cfg, "DELETE", `/connections/${id}`)
export const connectionStatus = (cfg: BackendConfig) =>
  call<{ providers: RemoteProvider[] }>(cfg, "GET", "/integrations/connections/status")
/** The workspace integrations catalog: what each provider's web form asks for. */
export const integrationsCatalog = (cfg: BackendConfig) => call<unknown>(cfg, "GET", "/datamate_integrations/")
