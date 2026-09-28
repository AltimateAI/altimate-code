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
  /** The user who owns the workspace. Linking needs only visibility, but
   * attaching a skill is a write against the workspace and needs ownership —
   * a caller that can see a colleague's shared workspace may link to it and
   * still not publish into it. Undefined when the backend omitted the field. */
  ownerId?: number
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

/** A 409 whose `existing_datamate_name` is withheld: the server hides the name of a workspace
 * the caller cannot see, which is almost always a teammate's private one. Reading that as a race
 * ("another workspace claimed this project while you were choosing") sent users round a retry
 * loop with no way out. */
export const HIDDEN_BINDING_MESSAGE =
  "This project is already linked to a workspace you can't see, most likely a teammate's private one. " +
  "Ask its owner to share it with you in the Altimate web app, or to unlink the project, then run `altimate-code link` again."

export function isHiddenBindingConflict(err: unknown): boolean {
  // A binding conflict always names the existing workspace's id; a 409 without one is some
  // other conflict and must not be explained as a teammate's private workspace.
  return (
    err instanceof ConflictError &&
    typeof err.detail.existing_datamate_id === "number" &&
    !err.detail.existing_datamate_name
  )
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
    /** Cap the response body. Off by default because this helper is shared and
     * some endpoints legitimately return large payloads (memory ``/list``
     * embeds block content and is not capped server-side). Set it where the
     * body size is attacker- or accident-controlled, as skill file downloads
     * are. */
    boundResponse?: boolean
    /** Override the base path prefix. Defaults to
     * ``/datamate-project-bindings`` (this module's namespace). Pass e.g.
     * ``/datamates`` to hit the sibling datamates_router through the same
     * timeout / typed-error / empty-body machinery. */
    base?: string
    /** If true, a 2xx with an empty body returns ``undefined`` typed as T
     * instead of throwing. Only set for endpoints known to return 204 or a
     * bare 200 with no payload. */
    allowEmptyBody?: boolean
    /** Override the shared 15s budget. That budget was sized for small JSON
     * exchanges and covers the request body too, so a call that uploads
     * megabytes (a skill bundle) needs its own. */
    timeoutMs?: number
    /** Act as THIS credential rather than resolving the ambient one.
     *
     * `creds()` reads the credentials afresh on every call, so a caller that
     * needs its request and its own bookkeeping to be about the same principal
     * cannot get that by reading them itself — the request would resolve them
     * again, and an account switch in between makes the two disagree. Comparing
     * before and after does not close it either: A→B→A passes the comparison
     * while the request was served as B. Passing the captured credential is the
     * only form that cannot drift.
     *
     * Callers that pass this have already read the credential, so the
     * `isConfigured()` gate inside `creds()` — a file-existence check on the
     * same file they just read — is skipped. The one behavioural difference:
     * deleting the credentials file mid-flight no longer aborts THIS request.
     * It still completes as the principal it captured, and the next call fails
     * at its own credential read. */
    actAs?: { url: string; instance: string; apiKey: string }
  } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  const { url, instance, apiKey } = opts.actAs ?? (await creds())
  const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : ""
  const basePath = opts.base ?? "/datamate-project-bindings"
  const target = `${url}${basePath}${subpath}${qs}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
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
    // Bound the body before buffering it. `res.text()` reads to completion, so
    // a response far larger than advertised is an out-of-memory crash before
    // any size check downstream can reject it. Content-Length is a hint, not a
    // guarantee, so the stream is also cut off at the cap.
    if (opts.boundResponse) {
      const declared = Number(res.headers.get("content-length") ?? Number.NaN)
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        throw new WorkspaceApiError(
          `Response from ${target} declares ${declared} bytes, over the ${MAX_RESPONSE_BYTES} limit`,
        )
      }
      text = await readBounded(res, target)
    } else {
      text = await res.text()
    }
  } catch (err) {
    // Distinguish "we hit our 15s abort" from "network stack failed" so the
    // caller can decide differently (retry, longer timeout, offline banner).
    // The abort fires equally when it kills the fetch OR the body read. (m8)
    const name = (err as { name?: string } | undefined)?.name
    if (name === "AbortError") {
      throw new WorkspaceApiError(
        `Request to ${target} timed out after ${Math.round(timeoutMs / 1000)}s`,
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
/** Ceiling on a single response body, applied ONLY where a caller opts in.
 *
 * Nothing upstream bounds what a workspace can hold and the body is buffered
 * whole, so an oversized response is a process crash rather than a failed
 * request. But this helper is shared: memory `/list` embeds block content and is
 * deliberately not capped server-side, so a blanket limit would fail requests
 * that work today. Skill file downloads opt in; everything else is unchanged. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** Read a response body, refusing to buffer past the cap. */
async function readBounded(res: Response, target: string): Promise<string> {
  // No stream to meter (a mocked or bodyless response): fall back to the
  // unbounded read, then enforce the cap on what actually arrived so this
  // branch cannot be used to bypass it.
  if (!res.body) {
    const whole = await res.text()
    if (Buffer.byteLength(whole, "utf8") > MAX_RESPONSE_BYTES) {
      throw new WorkspaceApiError(
        `Response from ${target} exceeded the ${MAX_RESPONSE_BYTES} byte limit`,
      )
    }
    return whole
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        throw new WorkspaceApiError(
          `Response from ${target} exceeded the ${MAX_RESPONSE_BYTES} byte limit`,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

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

  /** Detach this project from its workspace, server-side.
   *
   * Returns false when the server had no active binding to remove — the project
   * was already unlinked, by someone else or on another machine. That is a
   * distinct outcome from "removed", not an error, so the caller can tell the
   * user which happened.
   *
   * A local-only unlink is not possible: ``lookupBinding`` re-asks the server
   * whenever the cache misses, so a row dropped only on disk comes straight back
   * on the next resolve. */
  export async function unbindProject(id: ProjectIdentifier): Promise<boolean> {
    const query: Record<string, string> = {}
    // Send exactly one identifier. The endpoint answers 409 when both are given
    // and they name different bindings, and preferring the remote matches how
    // ``getBindingForProject`` resolves — so unlink removes the binding that
    // lookup would have found.
    if (id.repoRemote) query.repo_remote = id.repoRemote
    else if (id.projectPath) query.project_path = id.projectPath
    else return false
    try {
      await req<unknown>("DELETE", "/", { query, allowEmptyBody: true })
      return true
    } catch (err) {
      if (err instanceof NotFoundError) return false
      throw err
    }
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

  /** Create a workspace WITHOUT binding anything to it.
   *
   * ``createAndBind`` is the right call for an unlinked project: it creates and
   * binds in one server-side transaction, so a binding conflict cannot strand a
   * workspace. But it pre-checks the identifiers and 409s *before* creating,
   * which makes it unusable when the project is already linked — there is
   * nothing to create, and the caller's rebind never gets a target.
   * This is the two-step path for that case: create here, then rebind.
   *
   * The flags below deliberately mirror ``_create_datamate_flush_only`` in
   * altimate-backend, which is what ``createAndBind`` reaches. ``POST
   * /datamates/`` is the SaaS/extension creation path and defaults BOTH to
   * false, so omitting them would hand a differently-configured workspace to
   * whichever caller happened to be already linked — same menu row, memory and
   * knowledge engine silently off. If the backend's workspace defaults move,
   * this has to move with them; there is no endpoint that applies them without
   * also binding.
   */
  /** Who the next call will act as.
   *
   * A create-then-rebind pair is two requests, and `req()` resolves credentials
   * independently for each. If the account changes in between — a re-login, an
   * edited `altimate.json` — the workspace is created in one tenant and the
   * rebind is sent to another with an id that is local to the first. Callers
   * capture this before the create and re-check it before the rebind.
   *
   * The API key is deliberately not part of it: rotating a key for the same
   * user on the same tenant is not an identity change, and comparing it would
   * abort a legitimate flow. */
  export async function accountFingerprint(): Promise<{ apiUrl: string; tenant: string }> {
    const c = await creds()
    return { apiUrl: c.url, tenant: c.instance }
  }

  /** True when `before` still describes the account in effect. */
  export async function sameAccount(before: { apiUrl: string; tenant: string }): Promise<boolean> {
    const now = await accountFingerprint().catch(() => null)
    return now !== null && now.apiUrl === before.apiUrl && now.tenant === before.tenant
  }

  export async function createWorkspaceUnbound(input: {
    name: string
    description?: string
  }): Promise<{ id: number; name: string }> {
    const data = await req<{ id: number }>("POST", "/", {
      base: "/datamates",
      body: {
        name: input.name,
        description: input.description ?? null,
        integrations: [],
        memory_enabled: true,
        knowledge_engine_enabled: true,
        privacy: "private",
      },
    })
    // `typeof` FIRST, before any arithmetic. `Number()` coerces, so the
    // previous `Number.isSafeInteger(Number(data?.id))` accepted `true` as 1,
    // `"7"` as 7 and `[5]` as 5 — a malformed body would have rebound the
    // project to whatever those coerced to (workspace 1, in the boolean case)
    // instead of failing. The server's `CreateDatamateResponse` is `{id: int}`
    // and FastAPI enforces it, so anything else here is a contract break worth
    // refusing loudly rather than guessing at.
    const id: unknown = (data as { id?: unknown } | null | undefined)?.id
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new WorkspaceApiError(
        `Workspace was created but the server returned no usable id (${JSON.stringify(id) ?? "undefined"}).`,
      )
    }
    return { id, name: input.name }
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
  /** `actAs` pins the request to a specific credential — see `req`'s `actAs`. Omitted, this
   * resolves the ambient credential as every other call does. */
  export async function listDatamates(actAs?: {
    url: string
    instance: string
    apiKey: string
  }): Promise<DatamateRef[]> {
    // Accept THREE response envelopes — today's ``{datamates: [...]}``, a
    // bare ``[...]``, and a generic ``{data: [...]}`` — so a backend
    // contract change (or compat layer) doesn't silently empty the picker.
    // (cubic-dev-ai round 3.)
    type Row = { id: number | string; name: string; memory_enabled?: boolean; user_id?: number }
    const body = await req<Row[] | { datamates?: Row[]; data?: Row[] }>("GET", "/", {
      base: "/datamates",
      ...(actAs ? { actAs } : {}),
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
      .map((d) => ({
        id: Number(d.id),
        name: d.name,
        memoryEnabled: d.memory_enabled,
        ownerId: Number.isInteger(d.user_id) ? d.user_id : undefined,
      }))
      .filter((d) => Number.isInteger(d.id) && d.id > 0 && typeof d.name === "string")
  }

  /** The caller's own user id, from ``GET /users/me``. Needed wherever the
   * client must compare ownership — skill attachment requires the caller to
   * OWN the workspace, and the credentials carry no user id of their own. */
  export async function whoami(): Promise<number> {
    const me = await req<{ id?: unknown }>("GET", "/me", { base: "/users" })
    const id = Number(me?.id)
    if (!Number.isInteger(id) || id <= 0) throw new WorkspaceApiError("The server did not say who this account is.")
    return id
  }
}
