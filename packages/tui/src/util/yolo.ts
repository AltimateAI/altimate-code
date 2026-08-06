// altimate_change — YOLO mode scoping rules, kept pure so they can be tested
// without standing up the sync context or a renderer.
//
// Two rules, both load-bearing:
//
// 1. Yolo is a property of the conversation the user turned it on in. Subagents
//    spawned by the task tool run in their own CHILD session
//    (packages/opencode/src/tool/task.ts creates one with parentID), so their
//    permission requests arrive tagged with the child id. Every lookup therefore
//    normalizes to the root ancestor, or enabling yolo would appear to do nothing
//    the moment the agent delegated work.
//
// 2. An explicit per-session choice beats the process-wide default. That default
//    comes from `--yolo` / ALTIMATE_CLI_YOLO. Without rule 2, a user who launched
//    with --yolo could never turn it off from the TUI, which the ctrl+y contract
//    requires ("allow users to disable it without confirmation").

/** Walk a session to the root of its parent chain. */
export function rootSessionID(sessionID: string, parentOf: (sessionID: string) => string | undefined): string {
  let current = sessionID
  const seen = new Set<string>([current])
  // Depth cap AND cycle detection: this runs on the permission-event hot path, and
  // a malformed parent chain (self-parent, or a cycle introduced by a bad restore)
  // must not spin forever.
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    const parentID = parentOf(current)
    if (!parentID || seen.has(parentID)) return current
    seen.add(parentID)
    current = parentID
  }
  return current
}

export const MAX_PARENT_DEPTH = 32

/**
 * Resolve whether yolo is active for the session a permission request came from.
 *
 * `overrides` is keyed by ROOT session id; `fallback` is the process-wide default.
 */
export function yoloEnabled(input: {
  sessionID: string
  overrides: Record<string, boolean | undefined>
  parentOf: (sessionID: string) => string | undefined
  fallback: boolean
}): boolean {
  const root = rootSessionID(input.sessionID, input.parentOf)
  return input.overrides[root] ?? input.fallback
}
