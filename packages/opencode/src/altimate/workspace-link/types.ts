// altimate_change — WorkspaceLink feature (docs/workspace-plan/CONTRACT.md §1).
//
// Shared request/response shapes for the (mock, for now) WorkspaceLink backend. Field names
// match CONTRACT.md exactly so these types describe the wire contract a real backend must
// eventually satisfy, not just this repo's mock.

/** Credential-stripped, best-effort project hint. Every field is optional/nullable per
 * CONTRACT.md §1.1/§1.2 — Path A's hint is built before the environment scan has run, so a
 * partially or entirely empty hint must be acceptable (ASSUMPTION A5). */
export interface WorkspaceLinkProjectHint {
  name?: string | null
  remote?: string | null
  adapter?: string | null
  model_count?: number | null
  source_count?: number | null
  test_count?: number | null
}

export interface CreateDeviceLinkPayload {
  client: string
  client_version: string
  project?: WorkspaceLinkProjectHint
  /** Full project_scan tool output — only attached when scan=yes (Path B). */
  scan_summary?: unknown
}

export interface CreateDeviceLinkResponse {
  link_id: string
  // altimate_change — checkpoint 8k: no more code-entry step. `verification_uri` now resolves
  // directly to the consent card (`${origin}/link/${link_id}`) — there is no separate human
  // code to type in. See link-service.ts's createDeviceLink for why `link_id` alone is already
  // an adequate opaque, one-time, short-TTL browser secret.
  verification_uri: string
  poll_token: string
  expires_in: number
  interval: number
}

export interface CreateSessionLinkPayload {
  client: string
  client_version: string
  project?: WorkspaceLinkProjectHint
}

export interface CreateSessionLinkAuth {
  authToken: string
  instance: string
  apiUrl: string
}

export interface CreateSessionLinkResponse {
  link_id: string
  poll_token: string
  manage_url: string
  expires_in: number
  interval: number
}

export type WorkspaceLinkPollResponse =
  | { status: "pending" }
  | { status: "declined" }
  | { status: "expired" }
  | {
      status: "approved"
      approved_by: string
      // `token` — checkpoint 8c, CONTRACT.md §1.3 amendment. Dogfood-era addition: opaque,
      // long-lived, (workspace, user)-scoped, revoked only by workspace deletion (never
      // expires on its own — see CONTRACT.md's own note on why production needs a real
      // expiry/rotation story before this ships beyond dogfood). Present only in the CLI-
      // facing poll response, deliberately never echoed back to the browser-facing
      // POST /api/link/:id/approve response — see link-service.ts's approveWithNewWorkspace.
      workspace: { id: string; name: string; slug: string; manage_url: string; token: string }
    }
