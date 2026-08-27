// Fork-only helpers for the `run` command (see FINAL harness-improvement plan):
//   W1.10 — honest turn accounting: compaction-machinery steps must not consume the
//           --max-turns budget. `step-start` parts carry only messageID/sessionID, so
//           the owning message's agent is resolved via a lookup populated from
//           `message.updated` events (the assistant message row is persisted — and its
//           event published — before its first step-start part streams).
//   W1.12 — E4 dual-attribution termination logging: every run records TWO independent
//           fields instead of one rc: `why_model_stopped` and `why_harness_stopped`,
//           so model-looping, tight budgets, and harness errors stop being conflated
//           into a single exit code (SWE-agent #1262 vs OpenHands #9344 needed
//           different fixes and were indistinguishable under rc-only accounting).
//   W1.1  — real error serialization: never a bare name, "[object Object]", or a
//           literal `{}` — automation needs the actual name/message/status.
export type WhyModelStopped = "stop" | "tool-call" | "explicit-done" | "length" | "content-filter" | "unknown"
export type WhyHarnessStopped = "budget-exhausted" | "timeout" | "error" | "idle-done" | "none"
export type Termination = {
  why_model_stopped: WhyModelStopped
  why_harness_stopped: WhyHarnessStopped
}

// Recoverable by design: auto-compaction handles context overflow and the session
// continues, so an overflow error event alone must not flip the run's rc or its
// harness-stop attribution.
const RECOVERABLE_ERROR_NAMES = new Set(["ContextOverflowError"])

// Timeout classification for why_harness_stopped="timeout" and retry decisions.
const TIMEOUT_PATTERN = /\btimed?\s*out\b|\bETIMEDOUT\b|TimeoutError/i

// W2.1 will make an explicit model DONE assertion the primary termination path;
// until it lands, a trailing DONE token in the final assistant text is the only
// signal available for the "explicit-done" attribution.
const DONE_PATTERN = /\bDONE\b[.!]?\s*$/

export function create() {
  const agents = new Map<string, string>()
  let turnCount = 0
  let lastFinishReason: string | undefined
  let lastTextExplicitDone = false
  let budgetExhausted = false
  let fatalError: { name: string; timeout: boolean } | undefined

  function isCompactionStep(messageID: string) {
    return agents.get(messageID) === "compaction"
  }

  return {
    /** Record an assistant message's agent so later part events can be attributed. */
    onAssistantMessage(info: { id: string; agent?: string }) {
      agents.set(info.id, info.agent ?? "")
    },
    isCompactionStep,
    /**
     * Count a step-start toward the turn budget unless it belongs to a
     * compaction-machinery message. Returns true when the step was counted.
     */
    onStepStart(messageID: string): boolean {
      if (isCompactionStep(messageID)) return false
      turnCount++
      return true
    },
    get turnCount() {
      return turnCount
    },
    onStepFinish(messageID: string, reason: string | undefined) {
      if (isCompactionStep(messageID)) return
      lastFinishReason = reason
    },
    onText(messageID: string, text: string) {
      if (isCompactionStep(messageID)) return
      lastTextExplicitDone = DONE_PATTERN.test(text.trim())
    },
    onSessionError(name: unknown, message?: string) {
      const errorName = typeof name === "string" && name.length > 0 ? name : "UnknownError"
      if (RECOVERABLE_ERROR_NAMES.has(errorName)) return
      // upstream_fix: preserve the FIRST fatal error rather than overwriting it. A
      // later cleanup/abort error (e.g. from tearing down after the original
      // failure) must not clobber the root cause that actually stopped the run —
      // onPromptResult below already uses this first-wins (`??=`) discipline; this
      // path used unconditional assignment, which was the odd one out.
      fatalError ??= {
        name: errorName,
        timeout: TIMEOUT_PATTERN.test(errorName) || TIMEOUT_PATTERN.test(message ?? ""),
      }
    },
    onBudgetExhausted() {
      budgetExhausted = true
    },
    /**
     * Inspect the prompt call's returned terminal assistant message. Transport
     * failures can be swallowed upstream into a clean-looking idle (observed: a
     * mid-stream provider error surfaces ONLY as finish="other" with no error
     * field and no session.error event), so the terminal message is the last
     * honest signal available. finish="error"/"other" are the AI SDK's abnormal
     * terminations; "stop"/"length"/"tool-calls"/"content-filter"/"unknown" are
     * not treated as fatal.
     */
    onPromptResult(info: { finish?: string; error?: { name?: unknown; data?: unknown } } | undefined) {
      if (!info) return
      if (info.error) {
        // altimate_change start — upstream_fix: do NOT route through onSessionError's
        // RECOVERABLE_ERROR_NAMES filter here. That filter exists for the mid-run streamed
        // session.error events, where a ContextOverflowError is routinely recoverable — auto-
        // compaction runs and the turn continues. `info` here is the prompt() call's FINAL
        // returned message; a ContextOverflowError reaching this point means auto-compaction
        // itself already exhausted its retries and gave up (SessionCompaction.process's
        // `result === "compact"` terminal path returns "stop", ending the run) — there is no
        // later step left to recover it, so it must always be fatal.
        const data = (info.error.data ?? {}) as Record<string, unknown>
        const errorName = typeof info.error.name === "string" && info.error.name.length > 0 ? info.error.name : "UnknownError"
        const message = typeof data.message === "string" ? data.message : undefined
        fatalError ??= { name: errorName, timeout: TIMEOUT_PATTERN.test(errorName) || TIMEOUT_PATTERN.test(message ?? "") }
        // altimate_change end
        return
      }
      if (info.finish === "error" || info.finish === "other") {
        fatalError ??= { name: `AbnormalFinish:${info.finish}`, timeout: false }
      }
    },
    /** True when the run ended by fatal abort — the process must exit nonzero (W1.1). */
    get fatal() {
      return budgetExhausted || fatalError !== undefined
    },
    /** E4 dual-attribution fields for the run record/output (W1.12). */
    termination(): Termination {
      const model: WhyModelStopped = (() => {
        // upstream_fix: a request that never reached a step-finish event (fatal
        // abort before any model output, or a swallowed transport failure) left
        // lastFinishReason undefined — this fell through to the "stop" default,
        // claiming a clean model-side stop for a generation that never completed.
        if (lastFinishReason === undefined) return "unknown"
        if (lastFinishReason === "stop") return lastTextExplicitDone ? "explicit-done" : "stop"
        if (lastFinishReason === "tool-calls" || lastFinishReason === "tool-call") return "tool-call"
        // upstream_fix: AI-SDK "length" (truncation) and "content-filter" used to
        // fall through to the same "stop" default, making a truncated or
        // content-filtered run indistinguishable from a clean success — exactly
        // what the dual-attribution split (W1.12) exists to prevent.
        if (lastFinishReason === "length") return "length"
        if (lastFinishReason === "content-filter") return "content-filter"
        return "unknown"
      })()
      const harness: WhyHarnessStopped = (() => {
        if (budgetExhausted) return "budget-exhausted"
        if (fatalError?.timeout) return "timeout"
        if (fatalError) return "error"
        // "idle-done" is reserved for the run-mode idle-done heuristic (W2.1);
        // a session that idles because the model finished is attributed to the
        // model, so the harness reason is "none".
        return "none"
      })()
      return { why_model_stopped: model, why_harness_stopped: harness }
    },
  }
}
export type Info = ReturnType<typeof create>

/**
 * Serialize a session error event's payload to a real name/message/status string.
 * Never returns a bare "[object Object]" or a literal "{}" (W1.1).
 */
export function serializeSessionError(error: unknown): string {
  if (error === undefined || error === null) return "UnknownError"
  if (typeof error !== "object") return String(error)
  const obj = error as { name?: unknown; data?: unknown }
  const name = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : "UnknownError"
  const data = (obj.data && typeof obj.data === "object" ? obj.data : {}) as Record<string, unknown>
  const status =
    typeof data.status === "number" || (typeof data.status === "string" && data.status.length > 0)
      ? data.status
      : typeof data.statusCode === "number"
        ? data.statusCode
        : undefined
  const message =
    typeof data.message === "string" && data.message.length > 0
      ? data.message
      : data.message !== undefined
        ? JSON.stringify(data.message)
        : undefined
  const head = status !== undefined ? `${name} (status ${status})` : name
  return message ? `${head}: ${message}` : head
}

/** Provider 5xx responses are retryable at the enqueue boundary (W1.1). */
export function isRetryableStatus(status: unknown): boolean {
  return typeof status === "number" && status >= 500 && status <= 599
}

/** Thrown transport failures that warrant an enqueue retry: timeouts and dropped connections. */
export function isRetryableThrown(error: unknown): boolean {
  if (error === undefined || error === null) return false
  const err = error as { name?: unknown; message?: unknown; code?: unknown }
  const text = [err.name, err.message, err.code].filter((v) => typeof v === "string").join(" ")
  return TIMEOUT_PATTERN.test(text) || /ECONNRESET|ECONNREFUSED|fetch failed|network error/i.test(text)
}

export * as RunAccounting from "./run-accounting"
