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
import { Telemetry } from "@/altimate/telemetry"

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

/** The other half of the same story, told to the person who creates the workspace.
 * A create from the CLI or the TUI is always `privacy: "private"`, and the server hides a
 * private workspace's binding from everyone else — so without this note the creator has no
 * way to know that the teammate who clones the repo next will be told it is unlinked, and
 * will hit `HIDDEN_BINDING_MESSAGE` with no idea who to ask. Lives here, beside that
 * message, because both the CLI command and the TUI plugin have to say it and neither can
 * import the other. */
export const QUICK_WORKSPACE_PRIVATE_NOTE =
  "Only you can see this workspace. Share it from its page in the Altimate web app so teammates who clone this repo are attached to it too."

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

/** A credential captured once and passed to every request of one flow, so the flow cannot
 * drift onto another account part-way: workspace and user ids are per tenant. */
export interface ActAs {
  url: string
  instance: string
  apiKey: string
}

async function creds(): Promise<{ url: string; instance: string; apiKey: string }> {
  if (!(await AltimateApi.isConfigured())) throw new NotConfiguredError()
  const c = await AltimateApi.getCredentials()
  return { url: c.altimateUrl, instance: c.altimateInstanceName, apiKey: c.altimateApiKey }
}

// altimate_change start — workspace telemetry helpers. Every failed workspace call reports
// `workspace_api_error` (or `workspace_auth_expired` on 401/403) with the endpoint masked of
// ids; the link lifecycle functions below report linked / created / switched / unlinked on the
// success response and `workspace_link_failed` with a reason class otherwise.
/** Endpoint labels come from a ROUTE TABLE, never from how a segment is spelled: an identifier,
 * a memory id or a file path equal to a route word must not reach telemetry. Each router the
 * workspace clients call lists the shapes of its subpaths as regular expressions with the label
 * they map to; a subpath that matches no shape, or a router not listed, is labelled with every
 * segment masked. Identifiers and file paths therefore cannot leak whatever they contain; an
 * unlisted new route only costs detail until it is added here. */
const ROUTES: Record<string, Array<[RegExp, string]>> = {
  "/datamate-project-bindings": [
    [/^\/?$/, "/"],
    [/^\/bind$/, "/bind"],
    [/^\/by-remote$/, "/by-remote"],
    [/^\/by-path$/, "/by-path"],
  ],
  "/datamates": [[/^\/?$/, "/"]],
  "/users": [[/^\/me$/, "/me"]],
  "/skills": [
    [/^\/[^/]+$/, "/:id"],
    [/^\/[^/]+\/datamates$/, "/:id/datamates"],
    [/^\/[^/]+\/files(\/.*)?$/, "/:id/files/:path"],
  ],
  "/datamates/memory": [
    [/^\/?$/, "/"],
    [/^\/list$/, "/list"],
    [/^\/[^/]+$/, "/:id"],
  ],
}

/** "METHOD /base/path" with every dynamic segment replaced from the route table above. */
export function endpointOf(method: string, basePath: string, subpath: string): string {
  const shapes = ROUTES[basePath]
  const maskAll = (p: string) =>
    p
      .split("/")
      .map((seg) => (seg === "" ? seg : ":id"))
      .join("/")
  if (!shapes) return `${method} ${maskAll(basePath)}${maskAll(subpath)}`
  const query = subpath.split("?")[0]
  for (const [shape, label] of shapes) if (shape.test(query)) return `${method} ${basePath}${label}`
  return `${method} ${basePath}${maskAll(query)}`
}

function workspaceIdIn(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined
  const b = body as Record<string, unknown>
  const id = b.datamate_id ?? b.target_datamate_id
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : undefined
}

function reportApiError(input: {
  endpoint: string
  status?: number
  kind: "4xx" | "5xx" | "network" | "timeout" | "response"
  workspaceId?: number
}) {
  const session_id = Telemetry.getContext().sessionId
  const ws = input.workspaceId !== undefined ? { workspace_id: input.workspaceId } : {}
  if (input.status === 401 || input.status === 403) {
    Telemetry.track({
      type: "workspace_auth_expired",
      timestamp: Date.now(),
      session_id,
      endpoint: input.endpoint,
      status: input.status,
      ...ws,
    })
    return
  }
  Telemetry.track({
    type: "workspace_api_error",
    timestamp: Date.now(),
    session_id,
    endpoint: input.endpoint,
    status_class: input.kind,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...ws,
  })
}

/** The reason class of a failed link call, for `workspace_link_failed`. */
export function linkFailureReason(err: unknown): "auth" | "not_found" | "network" | "conflict" | "other" {
  if (err instanceof ForbiddenError) return "auth"
  if (err instanceof NotFoundError) return "not_found"
  if (err instanceof ConflictError || err instanceof PreconditionFailedError) return "conflict"
  if (err instanceof WorkspaceApiError) {
    if (err.status === 401) return "auth"
    if (err.status === undefined) return "network" // unreachable or timed out: req() sets no status
  }
  return "other"
}

type LinkHow = "bind_existing" | "create_and_bind" | "create_unbound" | "rebind_remote" | "rebind_path"

async function linkAttempt<T>(how: LinkHow, workspaceId: number | undefined, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    Telemetry.track({
      type: "workspace_link_failed",
      timestamp: Date.now(),
      session_id: Telemetry.getContext().sessionId,
      how,
      reason: linkFailureReason(err),
      ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
    })
    throw err
  }
}

function trackSwitched(to: number, from: number | undefined, how: "rebind_remote" | "rebind_path") {
  Telemetry.track({
    type: "workspace_switched",
    timestamp: Date.now(),
    session_id: Telemetry.getContext().sessionId,
    to_workspace_id: to,
    ...(from !== undefined ? { from_workspace_id: from } : {}),
    how,
  })
  trackLinked(to, how)
}

function trackLinked(workspaceId: number, how: "bind_existing" | "create_and_bind" | "rebind_remote" | "rebind_path") {
  Telemetry.track({
    type: "workspace_linked",
    timestamp: Date.now(),
    session_id: Telemetry.getContext().sessionId,
    workspace_id: workspaceId,
    how,
  })
}
// altimate_change end

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
  const endpoint = endpointOf(method, basePath, subpath)
  const bodyWorkspaceId = workspaceIdIn(opts.body)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  let text: string
  let answered: number | undefined // the status once the server answered, for the catch below
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
    answered = res.status
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
      // A timeout after the server answered (the body stalled) keeps the answer's status:
      // a 500 whose body never arrives is still a 5xx row; a 2xx whose body never arrives
      // stays a timeout, with the status attached.
      reportApiError({
        endpoint,
        ...(answered !== undefined ? { status: answered } : {}),
        kind: answered === undefined ? "timeout" : answered >= 500 ? "5xx" : answered >= 400 ? "4xx" : "timeout",
        workspaceId: bodyWorkspaceId,
      })
      throw new WorkspaceApiError(`Request to ${target} timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    // The server answered and the body failed afterwards (readBounded's cap, a cut stream):
    // classify by the status it answered with, so an oversized 500 is still a 5xx row; only a
    // usable status with a bad body is "response". Before any answer it is transport.
    if (answered !== undefined) {
      reportApiError({
        endpoint,
        status: answered,
        kind: answered >= 500 ? "5xx" : answered >= 400 ? "4xx" : "response",
        workspaceId: bodyWorkspaceId,
      })
    } else {
      reportApiError({ endpoint, kind: "network", workspaceId: bodyWorkspaceId })
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
  if (!res.ok) {
    reportApiError({
      endpoint,
      status: res.status,
      kind: res.status >= 500 ? "5xx" : "4xx",
      workspaceId: bodyWorkspaceId,
    })
  }
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
    reportApiError({ endpoint, status: res.status, kind: "response", workspaceId: bodyWorkspaceId })
    throw new WorkspaceApiError(`Empty ${res.status} body from ${target} — expected JSON payload`, res.status)
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
      throw new WorkspaceApiError(`Response from ${target} exceeded the ${MAX_RESPONSE_BYTES} byte limit`)
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
        throw new WorkspaceApiError(`Response from ${target} exceeded the ${MAX_RESPONSE_BYTES} byte limit`)
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
  export async function getBindingForRemote(remote: string, actAs?: ActAs): Promise<GetBindingResponse | null> {
    try {
      return await req<GetBindingResponse>("GET", "/by-remote", {
        query: { repo_remote: remote },
        ...(actAs ? { actAs } : {}),
      })
    } catch (err) {
      if (err instanceof NotFoundError) return null
      throw err
    }
  }

  /** Symmetric pre-check by absolute project directory path (for projects
   * without a git remote). Returns null on 404. */
  export async function getBindingForPath(projectPath: string, actAs?: ActAs): Promise<GetBindingResponse | null> {
    try {
      return await req<GetBindingResponse>("GET", "/by-path", {
        query: { project_path: projectPath },
        ...(actAs ? { actAs } : {}),
      })
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
  export async function getBindingForProject(
    id: ProjectIdentifier,
    actAs?: ActAs,
  ): Promise<ProjectBindingLookup | null> {
    if (id.repoRemote) {
      const hit = await getBindingForRemote(id.repoRemote, actAs)
      if (hit) return { ...hit, matchedBy: "remote" }
    }
    if (id.projectPath) {
      const hit = await getBindingForPath(id.projectPath, actAs)
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
  /** `knownDatamateId`: the workspace the caller knows it is unlinking, for telemetry; the
   * endpoint identifies the binding by project, not by workspace, and answers nothing. */
  export async function unbindProject(id: ProjectIdentifier, knownDatamateId?: number): Promise<boolean> {
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
      Telemetry.track({
        type: "workspace_unlinked",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        ...(knownDatamateId !== undefined ? { workspace_id: knownDatamateId } : {}),
      })
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
    const res = await linkAttempt("create_and_bind", undefined, () =>
      req<CreateAndBindResponse>("POST", "/", {
        body: {
          name: input.name,
          repo_remote: input.identifier.repoRemote ?? null,
          project_path: input.identifier.projectPath ?? null,
          description: input.description ?? null,
        },
      }),
    )
    const id = res?.binding?.datamate_id ?? res?.datamate?.id
    if (typeof id === "number") {
      Telemetry.track({
        type: "workspace_created",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        workspace_id: id,
        how: "create_and_bind",
      })
      trackLinked(id, "create_and_bind")
    }
    return res
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
    const data = await linkAttempt("create_unbound", undefined, () =>
      req<{ id: number }>("POST", "/", {
        base: "/datamates",
        body: {
          name: input.name,
          description: input.description ?? null,
          integrations: [],
          memory_enabled: true,
          knowledge_engine_enabled: true,
          privacy: "private",
        },
      }),
    )
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
    // The create-then-rebind path for an already-linked project: the workspace exists
    // from here; the rebind that follows reports the switch and the link.
    Telemetry.track({
      type: "workspace_created",
      timestamp: Date.now(),
      session_id: Telemetry.getContext().sessionId,
      workspace_id: id,
      how: "create_unbound",
    })
    return { id, name: input.name }
  }

  /** The ambient credential as an `ActAs`, or null when none is configured. */
  export async function captureCredentials(): Promise<ActAs | null> {
    return creds().catch(() => null)
  }

  export async function bindExisting(
    datamateId: number,
    identifier: ProjectIdentifier,
    actAs?: ActAs,
  ): Promise<BindingResponse> {
    const res = await linkAttempt("bind_existing", datamateId, () =>
      req<BindingResponse>("POST", "/bind", {
        body: {
          datamate_id: datamateId,
          repo_remote: identifier.repoRemote ?? null,
          project_path: identifier.projectPath ?? null,
        },
        ...(actAs ? { actAs } : {}),
      }),
    )
    trackLinked(res?.binding?.datamate_id ?? datamateId, "bind_existing")
    return res
  }

  export async function rebindByRemote(input: {
    remote: string
    targetDatamateId: number
    expectedCurrentDatamateId?: number
    actAs?: ActAs
  }): Promise<BindingResponse> {
    const res = await linkAttempt("rebind_remote", input.targetDatamateId, () =>
      req<BindingResponse>("PUT", "/by-remote", {
        body: {
          repo_remote: input.remote,
          target_datamate_id: input.targetDatamateId,
          ...(input.expectedCurrentDatamateId !== undefined
            ? { expected_current_datamate_id: input.expectedCurrentDatamateId }
            : {}),
        },
        ...(input.actAs ? { actAs: input.actAs } : {}),
      }),
    )
    trackSwitched(res?.binding?.datamate_id ?? input.targetDatamateId, input.expectedCurrentDatamateId, "rebind_remote")
    return res
  }

  /** Path-identified rebind — symmetric to ``rebindByRemote`` for projects
   * without a git remote. */
  export async function rebindByPath(input: {
    projectPath: string
    targetDatamateId: number
    expectedCurrentDatamateId?: number
    actAs?: ActAs
  }): Promise<BindingResponse> {
    const res = await linkAttempt("rebind_path", input.targetDatamateId, () =>
      req<BindingResponse>("PUT", "/by-path", {
        body: {
          project_path: input.projectPath,
          target_datamate_id: input.targetDatamateId,
          ...(input.expectedCurrentDatamateId !== undefined
            ? { expected_current_datamate_id: input.expectedCurrentDatamateId }
            : {}),
        },
        ...(input.actAs ? { actAs: input.actAs } : {}),
      }),
    )
    trackSwitched(res?.binding?.datamate_id ?? input.targetDatamateId, input.expectedCurrentDatamateId, "rebind_path")
    return res
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
      rows = Array.isArray(body.datamates) ? body.datamates : Array.isArray(body.data) ? body.data : []
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
  export async function whoami(actAs?: ActAs): Promise<number> {
    const me = await req<{ id?: unknown }>("GET", "/me", { base: "/users", ...(actAs ? { actAs } : {}) })
    const id = Number(me?.id)
    if (!Number.isInteger(id) || id <= 0) throw new WorkspaceApiError("The server did not say who this account is.")
    return id
  }
}
