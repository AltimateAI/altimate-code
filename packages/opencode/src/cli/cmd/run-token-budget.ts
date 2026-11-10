// altimate_change start — fork-only token budget for `run` (--max-tokens)
// Sums the billed tokens of a run across its root session and every session
// descended from it (task children, and their children), and says when the
// running total reaches the limit. Pure: it observes the SDK event stream and
// never talks to the server, so the decision is testable without one.

/** Token counts as a `step-finish` part reports them. */
export type StepTokens = {
  input: number
  output: number
  cache: { read: number; write: number }
}

/** Billed weight of one step: a cache read costs a tenth of an input token. */
export function billedTokens(tokens: StepTokens): number {
  return tokens.input + tokens.output + tokens.cache.write + 0.1 * tokens.cache.read
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

export function create(rootSessionID: string, limit: number | undefined) {
  // Sessions known to descend from the root. A child announces itself through
  // `session.created`/`session.updated` (parentID) or through the parent's
  // task tool part (state.metadata.sessionId); either may arrive first, so
  // edges are kept until their parent is admitted.
  const sessions = new Set<string>([rootSessionID])
  const parents = new Map<string, string>()
  const counted = new Set<string>()
  let total = 0
  let exhausted = false

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
  }

  function link(id: unknown, parentID: unknown) {
    if (typeof id !== "string" || typeof parentID !== "string" || !id || !parentID) return
    if (id === rootSessionID) return
    parents.set(id, parentID)
    admit()
  }

  return {
    get total() {
      return total
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
     * Feed one SDK event. Returns true exactly once: on the step whose usage
     * takes the total to (or past) the limit. Without a limit it only counts.
     */
    observe(event: Event): boolean {
      const props = event.properties
      if (!props) return false
      if (event.type === "session.created" || event.type === "session.updated") {
        link(props.info?.id, props.info?.parentID)
      }
      if (event.type !== "message.part.updated") return false
      const part = props.part
      if (!part || typeof part.sessionID !== "string") return false
      if (part.type === "tool" && part.tool === "task") {
        link(part.state?.metadata?.sessionId ?? part.state?.input?.task_id, part.sessionID)
      }
      if (part.type !== "step-finish" || !sessions.has(part.sessionID)) return false
      const tokens = part.tokens as Partial<StepTokens> | undefined
      if (!tokens || typeof part.id !== "string" || counted.has(part.id)) return false
      counted.add(part.id)
      total += billedTokens({
        input: tokens.input ?? 0,
        output: tokens.output ?? 0,
        cache: { read: tokens.cache?.read ?? 0, write: tokens.cache?.write ?? 0 },
      })
      if (limit === undefined || exhausted || total < limit) return false
      exhausted = true
      return true
    },
  }
}
export type Info = ReturnType<typeof create>

export * as RunTokenBudget from "./run-token-budget"
// altimate_change end
