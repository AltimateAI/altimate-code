// altimate_change — WorkspaceLink feature (docs/workspace-plan/CONTRACT.md §1).
//
// THIS TALKS TO A MOCK BACKEND TODAY. See mock-server.ts's top-of-file comment: the real
// `{WORKSPACE_API_BASE}` host is CONTRACT.md's open ASSUMPTION A1, unconfirmed with the
// backend team. This client therefore never guesses a production host — the base URL is
// read from `ALTIMATE_WORKSPACE_LINK_API_URL` and required; if it's unset, every call fails
// closed with `WorkspaceLinkNotConfiguredError` rather than silently doing nothing or
// pointing at a made-up default.
//
// Modeled on the style of ../api/client.ts (AltimateApi): plain async functions, no class,
// fetch with an AbortController timeout. Every code path that calls this client MUST first
// check `Flag.ALTIMATE_WORKSPACE_LINK` (packages/core/src/flag/flag.ts) — this module itself
// does not gate on the flag, it only implements the wire protocol.
import type {
  CreateDeviceLinkPayload,
  CreateDeviceLinkResponse,
  CreateSessionLinkAuth,
  CreateSessionLinkPayload,
  CreateSessionLinkResponse,
  WorkspaceLinkPollResponse,
} from "./types"
import { describeFetchError } from "./fetch-error"

const REQUEST_TIMEOUT_MS = 15_000

/** Thrown by every WorkspaceLinkApi call when no base URL is configured. Fail closed: there
 * is no hardcoded production host to fall back to (CONTRACT.md ASSUMPTION A1 is still open). */
export class WorkspaceLinkNotConfiguredError extends Error {
  constructor() {
    super(
      "WorkspaceLink API base URL not configured. Set ALTIMATE_WORKSPACE_LINK_API_URL " +
        "(e.g. to a local mock server's url) — there is no default host.",
    )
    this.name = "WorkspaceLinkNotConfiguredError"
  }
}

/** CONTRACT.md ASSUMPTION A2: the Altimate LLM Gateway auth_token may be scoped to "make LLM
 * completions for instance X" with no accountable end-user identity claim attached. The mock
 * (and, per this contract, any real backend) signals that with 403 `{error:"insufficient_scope"}`
 * on POST /api/cli/workspace-links/session — surfaced here as a distinct, typed error so Path A
 * callers can fall back to the Path B device flow instead of just failing. */
export class WorkspaceLinkInsufficientScopeError extends Error {
  constructor() {
    super("WorkspaceLink session-link creation failed: token lacks accountable end-user identity scope")
    this.name = "WorkspaceLinkInsufficientScopeError"
  }
}

/** Any other non-2xx / network failure talking to the WorkspaceLink backend. */
export class WorkspaceLinkRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = "WorkspaceLinkRequestError"
  }
}

function baseUrl(): string {
  const configured = process.env["ALTIMATE_WORKSPACE_LINK_API_URL"]
  if (!configured) throw new WorkspaceLinkNotConfiguredError()
  return configured.replace(/\/+$/, "")
}

async function request(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: unknown }> {
  const url = `${baseUrl()}${path}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    })
    const json = await res.json().catch(() => undefined)
    return { status: res.status, json }
  } catch (err) {
    throw new WorkspaceLinkRequestError(describeFetchError(url, err, REQUEST_TIMEOUT_MS))
  } finally {
    clearTimeout(timeout)
  }
}

export namespace WorkspaceLinkApi {
  /** POST /api/cli/workspace-links — Path B, unauthenticated device-flow creation
   * (CONTRACT.md §1.1). */
  export async function createDeviceLink(payload: CreateDeviceLinkPayload): Promise<CreateDeviceLinkResponse> {
    const { status, json } = await request("POST", "/api/cli/workspace-links", { body: payload })
    if (status !== 201) {
      throw new WorkspaceLinkRequestError(`createDeviceLink failed with status ${status}`, status)
    }
    return json as CreateDeviceLinkResponse
  }

  /** POST /api/cli/workspace-links/session — Path A, authenticated session-extension creation
   * (CONTRACT.md §1.2). Throws {@link WorkspaceLinkInsufficientScopeError} on the A2 scope-denial
   * shape (403 `{error:"insufficient_scope"}`) so callers can fall back to
   * {@link createDeviceLink} instead of treating it as an opaque failure. */
  export async function createSessionLink(
    payload: CreateSessionLinkPayload,
    auth: CreateSessionLinkAuth,
  ): Promise<CreateSessionLinkResponse> {
    const { status, json } = await request("POST", "/api/cli/workspace-links/session", {
      body: payload,
      headers: {
        Authorization: `Bearer ${auth.authToken}`,
        "X-Altimate-Instance": auth.instance,
      },
    })
    if (status === 403 && (json as { error?: string } | undefined)?.error === "insufficient_scope") {
      throw new WorkspaceLinkInsufficientScopeError()
    }
    if (status !== 201) {
      throw new WorkspaceLinkRequestError(`createSessionLink failed with status ${status}`, status)
    }
    return json as CreateSessionLinkResponse
  }

  /** POST /api/cli/workspace-links/{linkId}/poll — shared poll endpoint (CONTRACT.md §1.3).
   * Any poll after a terminal status returns that same terminal status again (idempotent) —
   * callers should stop polling once they see anything other than `pending`. */
  export async function poll(linkId: string, pollToken: string): Promise<WorkspaceLinkPollResponse> {
    const { status, json } = await request("POST", `/api/cli/workspace-links/${encodeURIComponent(linkId)}/poll`, {
      body: { poll_token: pollToken },
    })
    if (status !== 200) {
      throw new WorkspaceLinkRequestError(`poll failed with status ${status}`, status)
    }
    return json as WorkspaceLinkPollResponse
  }
}
