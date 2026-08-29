// Fork-only module — nudge arbiter.
//
// At most ONE system-authored directive block may be injected per turn.
// Precedence (highest first):
//   termination_challenge (item 1) > starvation_breaker (item 4) > budget_reminder (item 9)
//
// Items register candidate directives during a step; the delivery site (the
// session processor, at the start of the next generation) calls `take()` and
// injects only the single highest-precedence winner. All other pending
// directives for that turn are DROPPED, not deferred — detectors re-register
// on the next step if their condition still holds, so deferral would only
// create stale directives. This ships with item 4 (the first of items 1/4/9
// to land); items 1 and 9 register through the same registry when they ship.
export namespace NudgeArbiter {
  export type Source = "termination_challenge" | "starvation_breaker" | "budget_reminder"

  // Precedence order — index 0 wins.
  export const PRECEDENCE: readonly Source[] = ["termination_challenge", "starvation_breaker", "budget_reminder"]

  export interface Directive {
    source: Source
    // A stable machine-readable tag for telemetry (e.g. "starvation", "repeat_signature").
    kind: string
    text: string
  }

  // Session-scoped pending directives. Bounded so long-lived server processes
  // cannot accumulate state for dead sessions.
  const MAX_SESSIONS = 128
  const pendingBySession = new Map<string, Directive[]>()

  function bucket(sessionID: string): Directive[] {
    let b = pendingBySession.get(sessionID)
    if (!b) {
      b = []
      if (pendingBySession.size >= MAX_SESSIONS) {
        // Evict the LEAST-RECENTLY-USED session (front of the Map after the
        // refresh-on-access below), never the oldest-created — a long-running
        // active session must not lose a pending directive to churn from
        // short-lived ones.
        const oldest = pendingBySession.keys().next().value
        if (oldest !== undefined) pendingBySession.delete(oldest)
      }
    } else {
      // Refresh recency: re-insert so Map iteration order tracks last access.
      pendingBySession.delete(sessionID)
    }
    pendingBySession.set(sessionID, b)
    return b
  }

  /** Register a candidate directive for the session's next injected turn.
   *  altimate_change start — replace by SOURCE, not source+kind. Only one
   *  directive per source is ever delivered, and `take()` picked the EARLIEST
   *  match, so a single generation that crossed two rungs of the doom-loop
   *  ladder (nudge, then the stronger status_check) delivered the stale nudge
   *  and dropped the escalation with the rest of the bucket. The latest
   *  registration from a source is the current one, so it wins. */
  export function register(sessionID: string, directive: Directive): void {
    const b = bucket(sessionID)
    const existing = b.findIndex((d) => d.source === directive.source)
    if (existing >= 0) b[existing] = directive
    else b.push(directive)
  }
  // altimate_change end

  /** Pending directives (test/telemetry visibility only). */
  export function pending(sessionID: string): readonly Directive[] {
    return pendingBySession.get(sessionID) ?? []
  }

  /** Return the single highest-precedence directive and clear ALL pending
   *  directives for the session — at most one directive block per turn. */
  export function take(sessionID: string): Directive | undefined {
    const b = pendingBySession.get(sessionID)
    if (!b || b.length === 0) return undefined
    let winner: Directive | undefined
    for (const source of PRECEDENCE) {
      winner = b.find((d) => d.source === source)
      if (winner) break
    }
    pendingBySession.delete(sessionID)
    return winner
  }

  export function clear(sessionID: string): void {
    pendingBySession.delete(sessionID)
  }
}
