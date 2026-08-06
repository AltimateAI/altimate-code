// altimate_change — YOLO mode scoping rules, kept pure so they can be tested
// without standing up the sync context or a renderer.
//
// Three rules, all load-bearing:
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
//
// 3. An unresolvable session FAILS CLOSED. The parent chain is resolved against
//    the TUI's session store, which is populated by events and can lag behind a
//    permission request for a freshly created child. If we cannot prove which root
//    a request belongs to, we must not auto-approve it — otherwise a request whose
//    root the user explicitly turned OFF would miss that override and inherit a
//    `--yolo` fallback of true. Failing closed only ever costs a prompt.

export const MAX_PARENT_DEPTH = 32

export type SessionNode = { readonly parentID?: string }

/**
 * Resolve a session to the root of its parent chain.
 *
 * Returns `undefined` when the chain cannot be resolved: an unknown session
 * anywhere in the chain, or a chain longer than MAX_PARENT_DEPTH (which also
 * covers a cycle introduced by a bad restore). Callers must treat `undefined`
 * as "do not auto-approve".
 */
export function resolveRoot(
  sessionID: string,
  getSession: (sessionID: string) => SessionNode | undefined,
): string | undefined {
  let current = sessionID
  const seen = new Set<string>([current])
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    const session = getSession(current)
    // Unknown session: we cannot tell a true root from an unhydrated child.
    if (!session) return undefined
    const parentID = session.parentID
    if (!parentID || seen.has(parentID)) return current
    seen.add(parentID)
    current = parentID
  }
  return undefined
}

/**
 * Resolve whether yolo is active for the session a permission request came from.
 *
 * `overrides` is keyed by ROOT session id. `fallback` is the process-wide default
 * (`--yolo`) and must NOT carry any pre-session/pending choice — a pending choice
 * belongs to the session about to be created, not to every session that happens to
 * have no explicit override.
 */
export function yoloEnabled(input: {
  sessionID: string
  overrides: Record<string, boolean | undefined>
  getSession: (sessionID: string) => SessionNode | undefined
  fallback: boolean
}): boolean {
  const root = resolveRoot(input.sessionID, input.getSession)
  if (root === undefined) return false
  return input.overrides[root] ?? input.fallback
}
