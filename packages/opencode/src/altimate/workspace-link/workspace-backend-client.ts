// altimate_change — checkpoint 8d/8e. The CLI→workspace-backend CRUD calls this feature needs:
// PATCHing repo_remote when the drift prompt's "keep and update" choice is picked (8d), and
// POSTing a memory entry from the workspace `remember` tool (8e). Same base URL as
// WorkspaceLinkApi (ALTIMATE_WORKSPACE_LINK_API_URL) — the handoff routes and the CRUD routes
// are served by the same single workspace-backend process (DOGFOOD.md's own architecture).
import { describeFetchError } from "./fetch-error"

const REQUEST_TIMEOUT_MS = 15_000

export class WorkspaceBackendNotConfiguredError extends Error {
  constructor() {
    super("ALTIMATE_WORKSPACE_LINK_API_URL is not set — cannot reach the workspace backend")
    this.name = "WorkspaceBackendNotConfiguredError"
  }
}

/** Mirrors the 403 {error:"memory_disabled"} shape the 8b route returns when the workspace's
 * memory toggle is off — a typed error so the remember tool can tell the difference between
 * "off" (a clean, expected outcome to relay to the user) and any other failure. */
export class WorkspaceMemoryDisabledError extends Error {
  constructor() {
    super("memory is off for this workspace")
    this.name = "WorkspaceMemoryDisabledError"
  }
}

function baseUrl(): string {
  const configured = process.env["ALTIMATE_WORKSPACE_LINK_API_URL"]
  if (!configured) throw new WorkspaceBackendNotConfiguredError()
  return configured.replace(/\/+$/, "")
}

export interface WorkspaceMemoryEntry {
  id: string
  workspace_id: string
  user_id: string
  type: string
  text: string
  source: string | null
  created_at: number
}

export namespace WorkspaceBackendApi {
  /** Best-effort: a failure here must never block launch — the caller catches and logs, the
   * local binding update (the part that actually matters for the next launch's drift check)
   * always happens regardless of whether this network call succeeds. */
  export async function patchWorkspaceRemote(workspaceId: string, token: string, repoRemote: string | null): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const url = `${baseUrl()}/api/workspaces/${encodeURIComponent(workspaceId)}`
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ repo_remote: repoRemote }),
        signal: controller.signal,
      }).catch((err) => {
        throw new Error(describeFetchError(url, err, REQUEST_TIMEOUT_MS))
      })
      if (!res.ok) throw new Error(`PATCH workspace failed with status ${res.status}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  /** checkpoint 8e. Throws {@link WorkspaceMemoryDisabledError} on the 8b route's 403
   * memory_disabled shape specifically, so the tool can surface that as a clean, expected
   * outcome rather than a generic failure. */
  export async function createMemoryEntry(
    workspaceId: string,
    token: string,
    input: { type: "correction" | "preference" | "observation"; text: string; source: string },
  ): Promise<WorkspaceMemoryEntry> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const url = `${baseUrl()}/api/workspaces/${encodeURIComponent(workspaceId)}/memory/entries`
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
        signal: controller.signal,
      }).catch((err) => {
        throw new Error(describeFetchError(url, err, REQUEST_TIMEOUT_MS))
      })
      if (res.status === 403) {
        const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined
        if (body?.error === "memory_disabled") throw new WorkspaceMemoryDisabledError()
      }
      if (!res.ok) throw new Error(`POST memory entry failed with status ${res.status}`)
      return (await res.json()) as WorkspaceMemoryEntry
    } finally {
      clearTimeout(timeout)
    }
  }
}
