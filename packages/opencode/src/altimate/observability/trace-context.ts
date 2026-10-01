/**
 * W3C trace context for a session's current turn.
 *
 * A client (the VS Code extension) sends `traceparent` with a prompt. The trace is bound to the
 * session for that turn and:
 *   - forwarded to the Altimate gateways (`traceparent` + `x-request-id`), whose Azure Monitor
 *     instrumentation adopts it as the request's `operation_Id`;
 *   - stamped on this process's log lines (`trace=<id>`) and App Insights events
 *     (`ai.operation.id`).
 * One id then joins the client's, altimate-code's and the backend's records of a failure.
 *
 * The prompt is handled asynchronously (`prompt_async` returns before the turn runs), so the
 * binding is per session rather than per async context.
 */
export namespace TraceContext {
  const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/
  /** Bound on remembered sessions; the oldest binding is dropped first. */
  const MAX_SESSIONS = 500
  /** Providers served by Altimate's backend — the only ones that record the trace. */
  const ALTIMATE_PROVIDERS = new Set(["altimate-backend", "altimate-free"])

  const bySession = new Map<string, { traceparent: string; traceId: string }>()

  /**
   * Binds the trace a client sent with a prompt to the session's turn. A prompt without a valid
   * `traceparent` clears the binding, so a later untraced turn is not filed under an old trace.
   */
  export function bind(sessionID: string, traceparent: string | undefined) {
    bySession.delete(sessionID)
    const match = traceparent ? TRACEPARENT.exec(traceparent.trim().toLowerCase()) : null
    if (!match) return
    bySession.set(sessionID, { traceparent: match[0], traceId: match[1] })
    if (bySession.size > MAX_SESSIONS) bySession.delete(bySession.keys().next().value!)
  }

  /** A subagent session runs as part of its parent's turn. */
  export function inherit(childSessionID: string, parentSessionID: string) {
    const parent = bySession.get(parentSessionID)
    if (parent) bySession.set(childSessionID, parent)
  }

  export function traceId(sessionID: string): string | undefined {
    return bySession.get(sessionID)?.traceId
  }

  /** Outgoing request headers for the session's trace; empty for non-Altimate providers. */
  export function headers(sessionID: string, providerID: string): Record<string, string> {
    const trace = bySession.get(sessionID)
    if (!trace || !ALTIMATE_PROVIDERS.has(providerID)) return {}
    return { traceparent: trace.traceparent, "x-request-id": trace.traceId }
  }
}
