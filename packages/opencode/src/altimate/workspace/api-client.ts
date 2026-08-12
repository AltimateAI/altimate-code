// altimate_change - new file
//
// Wire client for the workspace-binding endpoints in altimate-backend
// (/datamate-project-bindings/*, added by AI-8398). Shared between the TUI
// plugin (packages/opencode/src/plugin/tui/altimate/workspace.tsx) and the
// `altimate link` CLI subcommand (packages/opencode/src/cli/cmd/link.ts) so
// the two entry points can't drift on request shape / error handling.
//
// Reads AltimateApi credentials on every call so an account switch is picked
// up immediately without a plugin restart. All FastAPI HTTPException.detail
// bodies come out as `{"detail": <string|object>}` — we parse the object form
// for 409/412 and surface it as a typed error rather than a bare status code.
import { AltimateApi } from "@/altimate/api/client"

const REQUEST_TIMEOUT_MS = 15_000

export interface DatamateRef {
  id: number
  name: string
}

export interface Binding {
  id: number
  datamate_id: number
  datamate_name: string
  repo_remote: string
  created_at?: string
}

export interface CreateAndBindResponse {
  datamate: DatamateRef
  binding: Binding
  manage_url: string
}

export interface BindingResponse {
  binding: Binding
}

export interface GetBindingResponse {
  binding: Binding
  datamate: DatamateRef
}

export interface ConflictDetail {
  message: string
  existing_datamate_id?: number
  existing_datamate_name?: string | null
  repo_remote?: string
}

export interface PreconditionDetail {
  message: string
  actual_current_datamate_id?: number
  expected_current_datamate_id?: number
}

export class NotConfiguredError extends Error {
  constructor() {
    super("Altimate credentials not configured — sign in first.")
    this.name = "NotConfiguredError"
  }
}

export class ConflictError extends Error {
  constructor(public readonly detail: ConflictDetail) {
    super(detail.message)
    this.name = "ConflictError"
  }
}

export class PreconditionFailedError extends Error {
  constructor(public readonly detail: PreconditionDetail) {
    super(detail.message)
    this.name = "PreconditionFailedError"
  }
}

export class NotFoundError extends Error {
  constructor(msg = "Not found") {
    super(msg)
    this.name = "NotFoundError"
  }
}

export class ForbiddenError extends Error {
  constructor(msg = "Forbidden") {
    super(msg)
    this.name = "ForbiddenError"
  }
}

export class WorkspaceApiError extends Error {
  constructor(
    msg: string,
    public readonly status?: number,
  ) {
    super(msg)
    this.name = "WorkspaceApiError"
  }
}

async function creds(): Promise<{ url: string; instance: string; apiKey: string }> {
  if (!(await AltimateApi.isConfigured())) throw new NotConfiguredError()
  const c = await AltimateApi.getCredentials()
  return { url: c.altimateUrl, instance: c.altimateInstanceName, apiKey: c.altimateApiKey }
}

async function req<T>(
  method: string,
  subpath: string,
  opts: { body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const { url, instance, apiKey } = await creds()
  const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : ""
  const target = `${url}/datamate-project-bindings${subpath}${qs}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(target, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-tenant": instance,
      },
      signal: controller.signal,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new WorkspaceApiError(`Cannot reach ${target}: ${msg}`)
  } finally {
    clearTimeout(timeout)
  }
  let json: unknown = undefined
  const text = await res.text().catch(() => "")
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      /* non-JSON body — surface as opaque via status code below */
    }
  }
  const detail = (json as { detail?: unknown } | undefined)?.detail
  if (res.status === 404) throw new NotFoundError(typeof detail === "string" ? detail : "Not found")
  if (res.status === 403) throw new ForbiddenError(typeof detail === "string" ? detail : "Forbidden")
  if (res.status === 409) {
    const d =
      typeof detail === "object" && detail !== null
        ? (detail as ConflictDetail)
        : { message: typeof detail === "string" ? detail : "Conflict" }
    throw new ConflictError(d)
  }
  if (res.status === 412) {
    const d =
      typeof detail === "object" && detail !== null
        ? (detail as PreconditionDetail)
        : { message: typeof detail === "string" ? detail : "Precondition failed" }
    throw new PreconditionFailedError(d)
  }
  if (!res.ok) {
    throw new WorkspaceApiError(
      typeof detail === "string" ? detail : `Request failed with status ${res.status}`,
      res.status,
    )
  }
  return json as T
}

export namespace WorkspaceApi {
  /** Server-authoritative pre-check: is this remote already bound in this tenant? */
  export async function getBindingForRemote(remote: string): Promise<GetBindingResponse | null> {
    try {
      return await req<GetBindingResponse>("GET", "/by-remote", { query: { repo_remote: remote } })
    } catch (err) {
      if (err instanceof NotFoundError) return null
      throw err
    }
  }

  export async function createAndBind(input: {
    name: string
    repoRemote: string
    description?: string
  }): Promise<CreateAndBindResponse> {
    return req<CreateAndBindResponse>("POST", "/", {
      body: {
        name: input.name,
        repo_remote: input.repoRemote,
        description: input.description ?? null,
      },
    })
  }

  export async function bindExisting(datamateId: number, remote: string): Promise<BindingResponse> {
    return req<BindingResponse>("POST", "/bind", {
      body: { datamate_id: datamateId, repo_remote: remote },
    })
  }

  export async function rebindByRemote(input: {
    remote: string
    targetDatamateId: number
    expectedCurrentDatamateId?: number
  }): Promise<BindingResponse> {
    return req<BindingResponse>("PUT", "/by-remote", {
      body: {
        repo_remote: input.remote,
        target_datamate_id: input.targetDatamateId,
        ...(input.expectedCurrentDatamateId !== undefined
          ? { expected_current_datamate_id: input.expectedCurrentDatamateId }
          : {}),
      },
    })
  }

  /** Populates the "link to existing workspace" picker. Reuses the existing
   * /datamates/ list endpoint on the datamates_router. */
  export async function listDatamates(): Promise<DatamateRef[]> {
    const { url, instance, apiKey } = await creds()
    const res = await fetch(`${url}/datamates/`, {
      headers: { Authorization: `Bearer ${apiKey}`, "x-tenant": instance },
    })
    if (!res.ok)
      throw new WorkspaceApiError(`Failed to list workspaces (status ${res.status})`, res.status)
    const body = (await res.json()) as { datamates?: Array<{ id: number | string; name: string }> }
    return (body.datamates ?? []).map((d) => ({ id: Number(d.id), name: d.name }))
  }
}
