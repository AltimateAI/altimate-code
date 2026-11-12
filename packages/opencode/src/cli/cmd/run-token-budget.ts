// altimate_change start — fork-only token budget for `run` (--max-tokens)
// Sums the billed tokens of a run across its root session and every session
// descended from it (task children, and their children), and says when the
// running total reaches the limit. Pure: it observes the SDK event stream and
// never talks to the server, so the decision is testable without one.

/** Token counts as a `step-finish` part reports them; `output` excludes `reasoning`. */
export type StepTokens = {
  input: number
  output: number
  reasoning?: number
  cache: { read: number; write: number }
}

/**
 * Billed weight of one step in tenths of a token, an integer so a running sum
 * meets the limit exactly: reasoning is billed as output, a cache read costs a
 * tenth of an input token.
 */
export function billedTenths(tokens: StepTokens): number {
  const full = tokens.input + tokens.output + (tokens.reasoning ?? 0) + tokens.cache.write
  return Math.round(10 * full + tokens.cache.read)
}

/** Billed weight of one step: input + output + reasoning + cache writes + 0.1 × cache reads. */
export function billedTokens(tokens: StepTokens): number {
  return billedTenths(tokens) / 10
}

/** A billed total as reported: cache reads make it fractional, so keep one decimal rather than rounding to an integer. */
export function reportedTokens(total: number): number {
  return Math.round(total * 10) / 10
}

/** A `--max-tokens` value the budget can enforce: a positive integer. */
export function isValidMaxTokens(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
}

type Event = { type: string; properties: Record<string, any> }

/** Steps held for sessions not linked yet; the oldest is dropped beyond this. */
export const MAX_PENDING_STEPS = 1_000

export function create(rootSessionID: string, limit: number | undefined) {
  // Sessions known to descend from the root. A child announces itself through
  // `session.created`/`session.updated` (parentID) or through the parent's
  // task tool part (state.metadata.sessionId, set once the tool has resolved
  // the child); either may arrive first, so edges are kept until their parent
  // is admitted, and a step from a session not linked yet is held until it is.
  const sessions = new Set<string>([rootSessionID])
  const parents = new Map<string, string>()
  const counted = new Set<string>()
  const pending = new Map<string, { sessionID: string; tenths: number }>()
  let tenths = 0
  let exhausted = false

  function count(id: string, weight: number) {
    counted.add(id)
    tenths += weight
  }

  function admit() {
    let changed = true
    while (changed) {
      changed = false
      for (const [id, parentID] of parents) {
        if (sessions.has(id) || !sessions.has(parentID)) continue
        sessions.add(id)
        changed = true
      }
    }
    for (const [id, step] of pending) {
      if (!sessions.has(step.sessionID)) continue
      pending.delete(id)
      count(id, step.tenths)
    }
  }

  function step(part: Record<string, any>) {
    const tokens = part.tokens as Partial<StepTokens> | undefined
    if (!tokens || typeof part.id !== "string" || counted.has(part.id)) return
    const weight = billedTenths({
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cache: { read: tokens.cache?.read ?? 0, write: tokens.cache?.write ?? 0 },
    })
    if (sessions.has(part.sessionID)) return count(part.id, weight)
    pending.delete(part.id)
    pending.set(part.id, { sessionID: part.sessionID, tenths: weight })
    if (pending.size > MAX_PENDING_STEPS) pending.delete(pending.keys().next().value!)
  }

  function reached() {
    if (limit === undefined || exhausted || tenths < limit * 10) return false
    exhausted = true
    return true
  }

  function link(id: unknown, parentID: unknown) {
    if (typeof id !== "string" || typeof parentID !== "string" || !id || !parentID) return
    if (id === rootSessionID) return
    parents.set(id, parentID)
    admit()
  }

  return {
    get total() {
      return tenths / 10
    },
    get exhausted() {
      return exhausted
    },
    get limit() {
      return limit
    },
    isDescendant(sessionID: string) {
      return sessions.has(sessionID)
    },
    /**
     * Feed one SDK event. Returns true exactly once: on the event whose usage
     * takes the total to (or past) the limit. Without a limit it only counts.
     */
    observe(event: Event): boolean {
      const props = event.properties
      if (!props) return false
      if (event.type === "session.created" || event.type === "session.updated") {
        link(props.info?.id, props.info?.parentID)
      }
      if (event.type !== "message.part.updated") return reached()
      const part = props.part
      if (!part || typeof part.sessionID !== "string") return reached()
      if (part.type === "tool" && part.tool === "task") {
        // Only the id the tool resolved: a requested task_id may name a session
        // the tool refuses to resume, and then it starts a new child instead.
        link(part.state?.metadata?.sessionId, part.sessionID)
      }
      if (part.type === "step-finish") step(part)
      return reached()
    },
  }
}
export type Info = ReturnType<typeof create>

export * as RunTokenBudget from "./run-token-budget"
// altimate_change end
