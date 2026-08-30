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
  export type Generation = symbol

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
  interface Entry {
    generation?: Generation
    directives: Directive[]
  }
  const pendingBySession = new Map<string, Entry>()

  function store(sessionID: string, entry: Entry): void {
    const existed = pendingBySession.delete(sessionID)
    if (!existed && pendingBySession.size >= MAX_SESSIONS) {
      // Evict the LEAST-RECENTLY-USED session (front of the Map), never the
      // oldest-created — an active session is refreshed on each access.
      const oldest = pendingBySession.keys().next().value
      if (oldest !== undefined) pendingBySession.delete(oldest)
    }
    pendingBySession.set(sessionID, entry)
  }

  function bucket(sessionID: string, generation?: Generation): Entry | undefined {
    let entry = pendingBySession.get(sessionID)
    if (generation !== undefined && entry?.generation !== generation) return undefined
    if (!entry) entry = { directives: [] }
    store(sessionID, entry)
    return entry
  }

  /** Start a new active loop generation and invalidate all older callbacks. */
  export function begin(sessionID: string): Generation {
    const generation = Symbol(sessionID)
    store(sessionID, { generation, directives: [] })
    return generation
  }

  // altimate_change start — STRENGTH ordering within a source. Several
  // independent detectors register under `starvation_breaker`
  // (`doom_loop_nudge`, `doom_loop_status_check`, `repeat_signature`,
  // `starvation`), so neither "earliest wins" nor "latest wins" is correct:
  // the first delivered a stale nudge when the same generation had already
  // escalated to a status check, and the second let a later, weaker detector
  // clobber a stronger directive that fired earlier in the same step.
  // Rank the kinds explicitly instead — highest rank wins, and equal ranks
  // fall back to the latest registration (a re-fire of the same rung is
  // current information).
  const KIND_STRENGTH: Record<string, number> = {
    doom_loop_status_check: 3,
    repeat_signature: 2,
    starvation: 1,
    doom_loop_nudge: 1,
  }

  function strength(kind: string): number {
    return KIND_STRENGTH[kind] ?? 0
  }

  /** Register a candidate directive for the session's next injected turn.
   *  Registrations from the same source+kind replace; different kinds from one
   *  source coexist and are ranked by strength at `take()` time. */
  export function register(sessionID: string, directive: Directive, generation?: Generation): void {
    const entry = bucket(sessionID, generation)
    if (!entry) return
    const existing = entry.directives.findIndex(
      (d) => d.source === directive.source && d.kind === directive.kind,
    )
    if (existing >= 0) entry.directives[existing] = directive
    else entry.directives.push(directive)
  }
  // altimate_change end

  /** Pending directives (test/telemetry visibility only). */
  export function pending(sessionID: string): readonly Directive[] {
    return pendingBySession.get(sessionID)?.directives ?? []
  }

  /** Return the single highest-precedence directive and clear ALL pending
   *  directives for the session — at most one directive block per turn. */
  export function take(sessionID: string, generation?: Generation): Directive | undefined {
    const entry = pendingBySession.get(sessionID)
    if (!entry || (generation !== undefined && entry.generation !== generation) || entry.directives.length === 0)
      return undefined
    let winner: Directive | undefined
    for (const source of PRECEDENCE) {
      // altimate_change start — strongest directive within the winning source,
      // not merely the first registered one.
      for (const d of entry.directives) {
        if (d.source !== source) continue
        if (!winner || strength(d.kind) >= strength(winner.kind)) winner = d
      }
      // altimate_change end
      if (winner) break
    }
    // Keep the active generation token after delivery so detectors later in
    // this loop can register a directive for the next turn. Legacy tokenless
    // use retains the original delete-on-take behavior.
    if (generation === undefined) pendingBySession.delete(sessionID)
    else {
      entry.directives = []
      store(sessionID, entry)
    }
    return winner
  }

  export function clear(sessionID: string, generation?: Generation): void {
    const entry = pendingBySession.get(sessionID)
    if (generation !== undefined && entry?.generation !== generation) return
    pendingBySession.delete(sessionID)
  }
}
