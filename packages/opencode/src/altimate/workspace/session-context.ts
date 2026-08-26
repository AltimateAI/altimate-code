// altimate_change - new file
//
// Env-var handoff for the launch-time --workspace resolution result.
//
// The launch resolver runs on the TUI's MAIN thread (``cli/cmd/tui.ts``,
// before ``new Worker(...)`` — it prints via ``UI.println`` and would need
// stdout the worker owns). Consumers of "which workspace is this session
// pinned to?" run inside the TUI worker subprocess (its own JS heap; a
// module-level variable set on the main thread is invisible there).
//
// This codebase already solves the same problem for ``ALTIMATE_LAUNCH_ID``:
// ``tui.ts`` spawns the worker with ``env: { ...process.env, ... }`` and
// telemetry reads it back from ``process.env.ALTIMATE_LAUNCH_ID`` on either
// side. Same mechanism here — ``setResolvedWorkspaceId`` mutates
// ``process.env`` on the main thread; the existing worker-spawn env spread
// carries it across for free; ``getResolvedWorkspaceId`` reads it back from
// whichever thread calls it.
const ENV_WORKSPACE_ID = "ALTIMATE_RESOLVED_WORKSPACE_ID"

export function setResolvedWorkspaceId(id: number | null): void {
  if (id === null) {
    delete process.env[ENV_WORKSPACE_ID]
    return
  }
  process.env[ENV_WORKSPACE_ID] = String(id)
}

/** Returns the launch-flag-selected workspace id when the session was
 * started with ``--workspace <name>`` and the name resolved, else null.
 * Consumers should fall back to the local binding cache
 * (``readLocalBinding``) when this returns null. */
export function getResolvedWorkspaceId(): number | null {
  const raw = process.env[ENV_WORKSPACE_ID]
  if (!raw) return null
  // Guard against a malformed env var — a NaN would silently poison callers
  // that then bind against workspace id NaN. Return null so callers fall
  // through to their default resolution path.
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}
