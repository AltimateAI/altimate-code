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
  /** Whether the workspace has memory switched on. Surfaced as a user-facing
   * toggle in the workspace app, so callers that write memory must respect it.
   * Undefined when the backend omitted the field. */
  memoryEnabled?: boolean
}

export interface Binding {
  id: number
  datamate_id: number
  datamate_name: string
  /** Either ``repo_remote`` OR ``project_path`` is populated (at least one). */
  repo_remote: string | null
  project_path: string | null
  created_at?: string
}

/** Project identifier passed to create/bind endpoints. At least one field is
 * required by the backend's CHECK constraint; the CLI's resolveProjectIdentifier
 * always populates ``projectPath`` and populates ``repoRemote`` when available. */
export interface ProjectIdentifier {
  repoRemote?: string
  projectPath?: string
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

/** Which identifier arm the pre-check lookup actually matched on. Callers use
 * this to pick the correct rebind endpoint (``/by-remote`` vs ``/by-path``)
 * regardless of what the CURRENT identifier has — a repo whose remote was
 * renamed still resolves via its ``project_path``, and a later ``rebindByRemote``
 * would 404 because no binding exists under the new remote. (M3) */
export type MatchedIdentifier = "remote" | "path"

export interface ProjectBindingLookup extends GetBindingResponse {
  matchedBy: MatchedIdentifier
}

export interface ConflictDetail {
  message: string
  existing_datamate_id?: number
  existing_datamate_name?: string | null
  repo_remote?: string
  project_path?: string
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
  opts: {
    body?: unknown
    query?: Record<string, string>
    /** Override the base path prefix. Defaults to
     * ``/datamate-project-bindings`` (this module's namespace). Pass e.g.
     * ``/datamates`` to hit the sibling datamates_router through the same
     * timeout / typed-error / empty-body machinery. */
    base?: string
    /** If true, a 2xx with an empty body returns ``undefined`` typed as T
     * instead of throwing. Only set for endpoints known to return 204 or a
     * bare 200 with no payload. */
    allowEmptyBody?: boolean
  } = {},
): Promise<T> {
  const { url, instance, apiKey } = await creds()
  const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : ""
  const basePath = opts.base ?? "/datamate-project-bindings"
  const target = `${url}${basePath}${subpath}${qs}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let res: Response
  let text: string
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
    // Keep the AbortController timeout ACTIVE while we read the response body.
    // ``fetch()`` resolves after headers arrive; a server can send headers then
    // stall the body stream indefinitely, so pulling the body inside the same
    // try/finally is the difference between our 15s cap and hanging until TCP
    // gives up. (CR round 2.) Do NOT wrap in ``.catch(() => "")`` — that
    // swallows the AbortError from the timeout firing during the body read
    // and turns a stalled response into a false "empty body". Rejection
    // rethrows into the outer catch and is classified there. (cubic round 3.)
    text = await res.text()
  } catch (err) {
    // Distinguish "we hit our 15s abort" from "network stack failed" so the
    // caller can decide differently (retry, longer timeout, offline banner).
    // The abort fires equally when it kills the fetch OR the body read. (m8)
    const name = (err as { name?: string } | undefined)?.name
    if (name === "AbortError") {
      throw new WorkspaceApiError(
        `Request to ${target} timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`,
      )
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new WorkspaceApiError(`Cannot reach ${target}: ${msg}`)
  } finally {
    clearTimeout(timeout)
  }
  let json: unknown = undefined
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
  // A 2xx with an empty (or unparseable) body is not the same as a resource.
  // Callers dereference the return immediately (``.binding``, ``.datamate``,
  // ``.manage_url``), so silently handing back ``undefined as T`` produces a
  // ``TypeError`` inside caller code that the typed-error switches can't
  // classify. Surface it as a WorkspaceApiError instead — unless the caller
  // opted in via ``allowEmptyBody`` (e.g. 204 endpoints). Use ``== null`` so a
  // literal ``JSON.parse("null")`` (which sets json to null, not undefined)
  // is treated as an empty body too — otherwise ``null as T`` reaches callers
  // and .foo throws in a way the typed switches can't classify. (m7 + CR)
  if (json == null && !opts.allowEmptyBody) {
    throw new WorkspaceApiError(
      `Empty ${res.status} body from ${target} — expected JSON payload`,
      res.status,
    )
  }
  return json as T
}

/** Shared wire helper for sibling Altimate routers. Exported so callers that
 * need the same credential resolution, abort budget and typed-error mapping do
 * not duplicate any of it — see ./memory-api.ts, which drives
 * ``/datamates/memory/*`` through this exact path. Always pass an explicit
 * ``base``; the default is this module's own namespace. */
export { req as altimateRequest }

export namespace WorkspaceApi {
  /** Server-authoritative pre-check by git remote. Returns null on 404. */
  export async function getBindingForRemote(remote: string): Promise<GetBindingResponse | null> {
    try {
      return await req<GetBindingResponse>("GET", "/by-remote", { query: { repo_remote: remote } })
    } catch (err) {
      if (err instanceof NotFoundError) return null
      throw err
    }
  }

  /** Symmetric pre-check by absolute project directory path (for projects
   * without a git remote). Returns null on 404. */
  export async function getBindingForPath(projectPath: string): Promise<GetBindingResponse | null> {
    try {
      return await req<GetBindingResponse>("GET", "/by-path", { query: { project_path: projectPath } })
    } catch (err) {
      if (err instanceof NotFoundError) return null
      throw err
    }
  }

  /** Tries remote first (stronger identity), then path. Returns the first hit
   * TAGGED with which identifier matched, so a caller that later rebinds
   * picks the right endpoint even if the current identifier's remote has
   * changed since the binding was created (M3). Both fields on the
   * identifier are optional but at least one must be present. */
  export async function getBindingForProject(id: ProjectIdentifier): Promise<ProjectBindingLookup | null> {
    if (id.repoRemote) {
      const hit = await getBindingForRemote(id.repoRemote)
      if (hit) return { ...hit, matchedBy: "remote" }
    }
    if (id.projectPath) {
      const hit = await getBindingForPath(id.projectPath)
      if (hit) return { ...hit, matchedBy: "path" }
    }
    return null
  }

  export async function createAndBind(input: {
    name: string
    identifier: ProjectIdentifier
    description?: string
  }): Promise<CreateAndBindResponse> {
    return req<CreateAndBindResponse>("POST", "/", {
      body: {
        name: input.name,
        repo_remote: input.identifier.repoRemote ?? null,
        project_path: input.identifier.projectPath ?? null,
        description: input.description ?? null,
      },
    })
  }

  export async function bindExisting(
    datamateId: number,
    identifier: ProjectIdentifier,
  ): Promise<BindingResponse> {
    return req<BindingResponse>("POST", "/bind", {
      body: {
        datamate_id: datamateId,
        repo_remote: identifier.repoRemote ?? null,
        project_path: identifier.projectPath ?? null,
      },
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

  /** Path-identified rebind — symmetric to ``rebindByRemote`` for projects
   * without a git remote. */
  export async function rebindByPath(input: {
    projectPath: string
    targetDatamateId: number
    expectedCurrentDatamateId?: number
  }): Promise<BindingResponse> {
    return req<BindingResponse>("PUT", "/by-path", {
      body: {
        project_path: input.projectPath,
        target_datamate_id: input.targetDatamateId,
        ...(input.expectedCurrentDatamateId !== undefined
          ? { expected_current_datamate_id: input.expectedCurrentDatamateId }
          : {}),
      },
    })
  }

  /** Populates the "link to existing workspace" picker. Reuses the existing
   * ``/datamates/`` list endpoint on the datamates_router — routed through
   * the shared ``req()`` machinery so it inherits the 15s abort, typed
   * error mapping, empty-body guard, and detail-parsing everyone else
   * gets. (M5) Filters out non-integer / non-positive ids so a corrupt row
   * doesn't reach the picker as a "NaN" label that the caller then binds
   * against. */
  export async function listDatamates(): Promise<DatamateRef[]> {
    // Accept THREE response envelopes — today's ``{datamates: [...]}``, a
    // bare ``[...]``, and a generic ``{data: [...]}`` — so a backend
    // contract change (or compat layer) doesn't silently empty the picker.
    // (cubic-dev-ai round 3.)
    type Row = { id: number | string; name: string; memory_enabled?: boolean }
    const body = await req<Row[] | { datamates?: Row[]; data?: Row[] }>("GET", "/", {
      base: "/datamates",
    })
    let rows: Row[]
    if (Array.isArray(body)) {
      rows = body
    } else if (body && typeof body === "object") {
      // Guard each envelope field with Array.isArray — a non-array
      // ``datamates`` or ``data`` value (object / string / null) would
      // otherwise slip through and throw on ``.map`` below, taking the
      // picker down before it renders. (cubic round 4.)
      rows = Array.isArray(body.datamates)
        ? body.datamates
        : Array.isArray(body.data)
          ? body.data
          : []
    } else {
      rows = []
    }
    // Filter valid row objects BEFORE map (Kilo cycle 5) — a single ``null``
    // (or non-object) element in an otherwise-valid array would otherwise
    // throw ``TypeError: Cannot read properties of null`` on ``d.id`` before
    // the post-map filter can drop it. That's the exact picker-down failure
    // the round-3/4 envelope guards were added to prevent, just from a
    // per-element rather than per-envelope malformed value.
    return rows
      .filter((d): d is Row => d !== null && typeof d === "object")
      .map((d) => ({ id: Number(d.id), name: d.name, memoryEnabled: d.memory_enabled }))
      .filter((d) => Number.isInteger(d.id) && d.id > 0 && typeof d.name === "string")
  }
}
