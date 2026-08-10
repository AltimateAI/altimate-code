// altimate_change — checkpoint 8d, corrected in 8e. The mechanism for "the resolved workspace
// id + token become session context, available to whatever 8e's remember tool will read":
// environment variables, not an in-memory singleton.
//
// Why not the in-memory singleton 8d originally shipped: resolveWorkspaceForLaunch runs on the
// TUI's MAIN thread (cli/cmd/tui.ts, before the worker starts — it needs stdin/stdout for its
// prompts). Tool execution — where 8e's remember tool actually runs — happens inside the TUI's
// WORKER thread (cli/tui/worker.ts hosts the real Server/session runtime). A Bun/Node Worker
// gets its own JS heap; a module-level variable set on the main thread is invisible there. This
// codebase already has the answer for exactly this problem: tui.ts spawns the worker with
// `new Worker(file, { env: { ...process.env, ALTIMATE_LAUNCH_ID: ... } })` — Telemetry.launchId()
// reads that back via `process.env.ALTIMATE_LAUNCH_ID` from EITHER thread. Same mechanism here:
// setResolvedWorkspace() (called from resolve.ts on the main thread) sets process.env directly;
// tui.ts's existing `...process.env` spread when constructing the worker carries it across for
// free — no new plumbing needed there. getResolvedWorkspace() then reads it back, correctly,
// from whichever thread calls it.
const ENV_WORKSPACE_ID = "ALTIMATE_RESOLVED_WORKSPACE_ID"
const ENV_WORKSPACE_TOKEN = "ALTIMATE_RESOLVED_WORKSPACE_TOKEN"

export interface ResolvedWorkspaceSession {
  workspaceId: string
  token: string
}

export function setResolvedWorkspace(session: ResolvedWorkspaceSession | undefined) {
  if (!session) {
    delete process.env[ENV_WORKSPACE_ID]
    delete process.env[ENV_WORKSPACE_TOKEN]
    return
  }
  process.env[ENV_WORKSPACE_ID] = session.workspaceId
  process.env[ENV_WORKSPACE_TOKEN] = session.token
}

export function getResolvedWorkspace(): ResolvedWorkspaceSession | undefined {
  const workspaceId = process.env[ENV_WORKSPACE_ID]
  const token = process.env[ENV_WORKSPACE_TOKEN]
  if (!workspaceId || !token) return undefined
  return { workspaceId, token }
}
