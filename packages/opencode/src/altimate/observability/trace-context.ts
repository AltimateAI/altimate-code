/**
 * W3C trace context for a prompt turn.
 *
 * A client (the VS Code extension) sends `traceparent` with a prompt. The trace is bound to the
 * user message that prompt creates — the turn — not to the session, so overlapping prompts on a
 * busy session each keep their own trace and nothing outlives its turn. For that turn:
 *   - calls to the Altimate gateways carry `traceparent` (a fresh child span per call) and
 *     `x-request-id` (`<trace id>-<span id>`); the backend's Azure Monitor instrumentation adopts
 *     the trace as the request's `operation_Id`;
 *   - this process's log lines are tagged `trace=<id>` and its App Insights events get
 *     `ai.operation.id`.
 * One id then joins the client's, altimate-code's and the backend's records of a failure.
 *
 * Lifecycle: routes bind the turn's message id before prompting; the prompt loop marks the turn
 * it is running as the session's active one (for telemetry), lets an automatic compaction or a
 * subagent inherit it, and releases every binding it processed when its generation ends.
 */

/** `version-traceid-parentid-flags`, lower-case hex only, as W3C Trace Context requires. */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const ZERO_TRACE_ID = "0".repeat(32)
const ZERO_SPAN_ID = "0".repeat(16)
/** Bound on remembered turns; the oldest binding is dropped first. */
const MAX_BINDINGS = 500
/** Providers served by Altimate's backend — the only ones that receive the trace. */
const ALTIMATE_PROVIDERS = new Set(["altimate-backend", "altimate-free"])

export interface Trace {
  traceId: string
  flags: string
}

const byMessage = new Map<string, Trace>()
/** The turn each session is running right now, and its trace, for telemetry. */
const activeBySession = new Map<string, { messageID: string; traceId: string }>()

/**
 * Parses a `traceparent` header. Returns undefined for anything W3C says to ignore: a malformed
 * header, upper-case hex, or an all-zero trace or parent id.
 */
export function parse(header: string | undefined): Trace | undefined {
  const match = header ? TRACEPARENT.exec(header.trim()) : null
  if (!match || match[1] === ZERO_TRACE_ID || match[2] === ZERO_SPAN_ID) return undefined
  return { traceId: match[1], flags: match[3] }
}

/** Binds the trace a client sent with a prompt to the user message that prompt creates. */
export function bind(messageID: string, traceparent: string | undefined) {
  const trace = parse(traceparent)
  if (trace) remember(messageID, trace)
  else byMessage.delete(messageID)
}

/**
 * Gives `childMessageID` the trace of `parentMessageID`'s turn — a subagent's prompt, or an
 * automatic compaction inside the turn — or none, when that turn is untraced. Always replaces
 * the child's binding, so a resumed subagent never keeps an earlier turn's trace.
 */
export function inherit(childMessageID: string, parentMessageID: string) {
  const parent = byMessage.get(parentMessageID)
  if (parent) remember(childMessageID, parent)
  else byMessage.delete(childMessageID)
}

export function forMessage(messageID: string): Trace | undefined {
  return byMessage.get(messageID)
}

export function traceId(messageID: string): string | undefined {
  return byMessage.get(messageID)?.traceId
}

/** Marks `messageID`'s turn as the one `sessionID` is running now (or none, if untraced). */
export function activate(sessionID: string, messageID: string) {
  const trace = byMessage.get(messageID)
  if (trace) activeBySession.set(sessionID, { messageID, traceId: trace.traceId })
  else activeBySession.delete(sessionID)
}

/** The trace of the turn `sessionID` is running now. */
export function activeTraceId(sessionID: string): string | undefined {
  return activeBySession.get(sessionID)?.traceId
}

/**
 * Releases a finished prompt-loop generation: the bindings of exactly the turns it processed
 * (a prompt that arrives meanwhile keeps its own), and the session's active turn if it is one of
 * them (a newer generation's active turn is left alone).
 */
export function release(sessionID: string, messageIDs: Iterable<string>) {
  const released = new Set(messageIDs)
  for (const messageID of released) byMessage.delete(messageID)
  const active = activeBySession.get(sessionID)
  if (active && released.has(active.messageID)) activeBySession.delete(sessionID)
}

/**
 * Adds the turn's trace headers to an outgoing request for an Altimate provider. The two headers
 * are a unit: if the request headers (model config, plugins) or the provider's configured headers
 * already set either, neither is added — the SDK lets per-call headers override provider ones, so
 * both must be checked. Each call gets a fresh span id, so the backend can tell its requests
 * apart while joining them on the trace.
 */
export function withHeaders(
  headers: Record<string, string>,
  trace: Trace | undefined,
  providerID: string,
  providerHeaders?: unknown,
): Record<string, string> {
  if (!trace || !ALTIMATE_PROVIDERS.has(providerID)) return headers
  const configured = providerHeaders && typeof providerHeaders === "object" ? Object.keys(providerHeaders) : []
  const existing = [...Object.keys(headers), ...configured].map((key) => key.toLowerCase())
  if (existing.includes("traceparent") || existing.includes("x-request-id")) return headers
  const spanId = randomSpanId()
  return {
    ...headers,
    traceparent: `00-${trace.traceId}-${spanId}-${trace.flags}`,
    "x-request-id": `${trace.traceId}-${spanId}`,
  }
}

/** Number of turns currently bound (for tests and diagnostics). */
export function size(): number {
  return byMessage.size
}

/** One insertion path for every binding: replace, then evict the oldest past the bound. */
function remember(messageID: string, trace: Trace) {
  byMessage.delete(messageID)
  byMessage.set(messageID, trace)
  while (byMessage.size > MAX_BINDINGS) byMessage.delete(byMessage.keys().next().value!)
}

function randomSpanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return id === ZERO_SPAN_ID ? randomSpanId() : id
}

export * as TraceContext from "./trace-context"
