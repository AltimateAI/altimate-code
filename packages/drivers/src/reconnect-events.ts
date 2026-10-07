/**
 * A driver replacing a connection the warehouse closed (today: Snowflake after an idle
 * timeout, a network drop or laptop sleep). The reopen is silent to the caller, which is
 * the point, but without these events it was also missing from the log: a session that
 * kept dropping looked exactly like one that never did.
 */
export interface ReconnectEvent {
  warehouse: string
  /** Identifies which account the connection belongs to, e.g. the Snowflake account locator. */
  account?: string
  phase: "started" | "reconnected" | "failed"
  /** How the closed session showed: the SDK reported it down before a statement, or a statement was refused. */
  reason: "connection-down" | "statement-refused"
  /** From the start of the reconnect. On `reconnected` and `failed`. */
  durationMs?: number
  /** Session settings (USE, SET, ALTER SESSION…) restored on the new session. On `reconnected`. */
  settingsRestored?: number
  /** Temporary objects or an open transaction went with the old session. On `reconnected`. */
  sessionStateLost?: boolean
  /** On `failed`. */
  error?: string
}

type Listener = (event: ReconnectEvent) => void

// Process-global, for the same reason as the sign-in notices: the driver and its
// subscriber can be loaded through different module graphs.
const LISTENERS_KEY = Symbol.for("altimate.drivers.reconnectListeners")
const listeners: Set<Listener> = ((globalThis as Record<symbol, unknown>)[LISTENERS_KEY] as Set<Listener>) ??
  ((globalThis as Record<symbol, unknown>)[LISTENERS_KEY] = new Set<Listener>())

/** Subscribe to reconnect events from every driver. Returns the unsubscribe. */
export function onReconnect(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitReconnect(event: ReconnectEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // a broken listener must not fail the reconnect
    }
  }
}
