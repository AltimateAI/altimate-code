// altimate_change — WorkspaceLink feature. Minimal local record of the OUTCOME of a
// workspace-link poll, so a resolution that happens after the auth dialog (Path A) or the CLI
// process (Path B `altimate link`) has already moved on isn't completely undiscoverable.
//
// Deliberately a small JSON file (mirrors AltimateApi.saveCredentials's own file-based state,
// packages/opencode/src/altimate/api/client.ts), not a new drizzle table — deliverable #1 only
// asked for the scan-result cache table, and this is pure best-effort CLI-side bookkeeping
// (CONTRACT.md ASSUMPTION A8), not something that needs migrations or FK integrity.
//
// CONTRACT.md §2 "decline persists nothing... the CLI, symmetrically, writes no local
// workspace_id binding on decline" — callers of this module MUST only call `recordApproved`
// on an `approved` poll result. Declined/expired outcomes are surfaced via logging only (see
// altimate.ts's pollAndNotify), never persisted here.
import path from "path"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"

export interface WorkspaceLinkBinding {
  projectId: string
  linkId: string
  workspaceId: string
  workspaceName: string
  workspaceSlug: string
  manageUrl: string
  approvedBy: string
  linkedAt: number
  /** checkpoint 8c: the workspace-scoped credential (CONTRACT.md §1.3's dogfood-era `token`
   * field on the approved poll response) — what makes `--workspace <name>` able to call back
   * into the workspace backend later in the same or a future session. */
  token: string
  /** checkpoint 8d: captured at link time from the SAME cheap-detector hint sent to the
   * backend (buildProjectHint) — the launch-time drift check's stable reference point.
   * Deliberately NOT `workspaceName`/derived from the workspace row: the workspace can be
   * renamed later (editWs), which must never retroactively change what "drift" means for a
   * binding that was already correct when it was made. Keyed on BOTH fields together, not
   * remote alone — a monorepo can have multiple dbt projects sharing one git remote, and a
   * remote-only check would miss a real project swap within the same repo. */
  detectedRemote: string | null
  detectedProjectName: string | null
}

function statePath(): string {
  return path.join(Global.Path.state, "workspace-link.json")
}

async function readAll(): Promise<Record<string, WorkspaceLinkBinding>> {
  const p = statePath()
  if (!(await Filesystem.exists(p))) return {}
  try {
    return await Filesystem.readJson<Record<string, WorkspaceLinkBinding>>(p)
  } catch {
    return {}
  }
}

/** Persist an approved workspace-link binding for `projectId`. Only ever called with an
 * `approved` poll result — see the module-level note on why declined/expired must not persist. */
export async function recordApproved(projectId: string, binding: Omit<WorkspaceLinkBinding, "projectId">) {
  const all = await readAll()
  all[projectId] = { projectId, ...binding }
  await Filesystem.writeJson(statePath(), all, 0o600)
}

export async function readBinding(projectId: string): Promise<WorkspaceLinkBinding | undefined> {
  const all = await readAll()
  return all[projectId]
}
