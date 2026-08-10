// altimate_change — WorkspaceLink feature, Path B (docs/workspace-plan/CONTRACT.md §3).
//
// packages/tui depends on packages/core, not packages/opencode (see
// packages/core/src/flag/flag.ts's "the extracted TUI... depends on core not opencode" comment),
// so it cannot import WorkspaceLinkApi (packages/opencode/src/altimate/workspace-link/api-client.ts)
// directly. The actual HTTP calls to the (mock, for now) WorkspaceLink backend happen at the
// opencode layer instead — a small local httpapi route group,
// packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/workspace-link.ts,
// exposing bare `POST /workspace-link/device` and `POST /workspace-link/poll`.
//
// There is no generated per-route SDK method for either route: the generated OpenAPI client
// (packages/sdk/js/src/v2/gen/{sdk,types}.gen.ts, produced from packages/sdk/js/openapi.json) is
// deliberately NOT regenerated for this POC. And `OpencodeClient`'s own internal transport
// (`this.client`, a hey-api `{get,post,put,...}` generic client — see
// packages/sdk/js/src/v2/gen/client/client.gen.ts) is a `protected` member of a base class with
// no public getter, so there is no clean way to reach it from outside the generated SDK classes
// either. Rather than cast around that `protected` (or hand-edit generated files), this makes the
// same bare-path POST calls directly with the fetch already exposed by useSDK() — the same
// `url`/`directory`/`fetch` the real SDK client is built from (packages/tui/src/context/sdk.tsx).
export interface WorkspaceLinkSdkHandle {
  url: string
  directory?: string
  fetch: typeof fetch
}

// altimate_change — checkpoint 8k: no more code-entry step; verification_uri resolves directly
// to the consent card.
export interface WorkspaceLinkDeviceLink {
  link_id: string
  verification_uri: string
  poll_token: string
  expires_in: number
  interval: number
}

export type WorkspaceLinkPollResult =
  | { status: "pending" }
  | { status: "declined" }
  | { status: "expired" }
  | {
      status: "approved"
      approved_by: string
      workspace: { id: string; name: string; slug: string; manage_url: string }
    }

/** Thrown on any non-2xx response from the local /workspace-link/* routes. */
export class WorkspaceLinkHttpError extends Error {}

async function post<T>(sdk: WorkspaceLinkSdkHandle, path: string, body?: unknown): Promise<T> {
  const url = new URL(path, sdk.url)
  if (sdk.directory) url.searchParams.set("directory", sdk.directory)
  const res = await sdk.fetch(url.toString(), {
    method: "POST",
    ...(body !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  })
  const json = await res.json().catch(() => undefined)
  if (!res.ok) {
    const message =
      (json as { data?: { message?: string } } | undefined)?.data?.message ??
      `WorkspaceLink request to ${path} failed with status ${res.status}`
    throw new WorkspaceLinkHttpError(message)
  }
  return json as T
}

/** POST /workspace-link/device — Path B device-flow creation. The server builds the
 * project/scan-cache payload itself (handlers/workspace-link.ts reads
 * workspace_link_scan_cache for the current project) — the TUI sends no body at all. */
export function createWorkspaceLinkDevice(sdk: WorkspaceLinkSdkHandle): Promise<WorkspaceLinkDeviceLink> {
  return post<WorkspaceLinkDeviceLink>(sdk, "/workspace-link/device")
}

/** POST /workspace-link/poll — a single poll attempt (not blocking server-side); the caller
 * (dialog-workspace-link.tsx) owns the retry loop and the client-side expiry deadline, mirroring
 * altimate/workspace-link/poll-loop.ts's pollUntilResolved on the opencode side. */
export function pollWorkspaceLink(
  sdk: WorkspaceLinkSdkHandle,
  linkId: string,
  pollToken: string,
): Promise<WorkspaceLinkPollResult> {
  return post<WorkspaceLinkPollResult>(sdk, "/workspace-link/poll", { link_id: linkId, poll_token: pollToken })
}
