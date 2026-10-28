/**
 * Usage hints shown once per session. Tool output stays in the conversation and is re-read on every
 * later model request, so a tutorial repeated on each call costs tokens without adding information.
 */
const shown = new Map<string, Set<string>>()
/** Bounds the in-process record; the oldest sessions are dropped first. */
const MAX_SESSIONS = 1_000

/** True the first time `key` is asked for in this session, false afterwards. */
export function firstTime(sessionID: string, key: string): boolean {
  let keys = shown.get(sessionID)
  if (!keys) {
    keys = new Set()
    shown.set(sessionID, keys)
    if (shown.size > MAX_SESSIONS) shown.delete(shown.keys().next().value!)
  }
  if (keys.has(key)) return false
  keys.add(key)
  return true
}
