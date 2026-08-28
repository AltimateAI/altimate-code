// Fork-only helpers for the `run` command:
//   - honest turn accounting: compaction-machinery steps must not consume the
//     --max-turns budget. `step-start` parts carry only messageID/sessionID, so
//     the owning message's agent is resolved via a lookup populated from
//     `message.updated` events (the assistant message row is persisted — and its
//     event published — before its first step-start part streams).
//   - dual-attribution termination logging: every run records TWO independent
//     fields instead of one rc: `why_model_stopped` and `why_harness_stopped`,
//     so model-looping, tight budgets, and harness errors stop being conflated
//     into a single exit code (SWE-agent #1262 vs OpenHands #9344 needed
//     different fixes and were indistinguishable under rc-only accounting).
//   - real error serialization: never a bare name, "[object Object]", or a
//     literal `{}` — automation needs the actual name/message/status.
//   - done_reason emission (explicit_done vs idle_heuristic vs none) and the
//     idle-done challenge bookkeeping; DONE detection delegates to the
//     SessionTermination completion-token contract.
import { SessionTermination } from "../../session/termination"

export namespace RunAccounting {
  export type WhyModelStopped = "stop" | "tool-call" | "explicit-done"
  export type WhyHarnessStopped = "budget-exhausted" | "timeout" | "error" | "idle-done" | "none"
  // done_reason distinguishes an unprompted completion assertion
  // (explicit_done — the PRIMARY termination path) from one elicited by the
  // idle-done confirm challenge (idle_heuristic). "none" = the session ended
  // without any completion assertion — bare finishReason "stop" is NEVER
  // reported as done.
  export type DoneReason = "explicit_done" | "idle_heuristic" | "none"
  export type Termination = {
    why_model_stopped: WhyModelStopped
    why_harness_stopped: WhyHarnessStopped
    done_reason: DoneReason
  }

  // Recoverable by design: auto-compaction handles context overflow and the session
  // continues, so an overflow error event alone must not flip the run's rc or its
  // harness-stop attribution.
  const RECOVERABLE_ERROR_NAMES = new Set(["ContextOverflowError"])

  // Timeout classification for why_harness_stopped="timeout" and retry decisions.
  const TIMEOUT_PATTERN = /\btimed?\s*out\b|\bETIMEDOUT\b|TimeoutError/i

  // the explicit model DONE assertion is the primary termination path.
  // Detection delegates to the SessionTermination completion-token contract —
  // the single detector shared with the processor stop-path and the idle-done
  // challenge, so instruction and detection can never drift apart.

  export function create() {
    const agents = new Map<string, string>()
    let turnCount = 0
    let lastFinishReason: string | undefined
    let lastTextExplicitDone = false
    let budgetExhausted = false
    let fatalError: { name: string; timeout: boolean } | undefined
    // set when the run-mode idle-done fallback issued its one-shot
    // confirm-DONE challenge (see cli/cmd/idle-done.ts). Scoped to the
    // challenge GENERATION, not the run lifetime: the turn at issuance is
    // recorded so only a DONE in the immediately-following generation is
    // attributed to the heuristic — a later unprompted DONE (after the model
    // declined the challenge and kept working) is honest explicit_done.
    let idleDoneChallengeTurn: number | undefined
    let lastExplicitDoneTurn: number | undefined
    // the harness delivers the challenge by aborting ONE in-flight prompt;
    // each suppression may fire at most once — later aborts/abnormal
    // finishes are real failures.
    let challengeAbortSuppressed = false
    let challengeFinishSuppressed = false

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
        lastTextExplicitDone = SessionTermination.isExplicitDone(text)
        lastExplicitDoneTurn = lastTextExplicitDone ? turnCount : undefined
      },
      /** the idle-done fallback issued its one-shot confirm-DONE challenge. */
      onIdleDoneChallengeIssued() {
        idleDoneChallengeTurn = turnCount
      },
      onSessionError(name: unknown, message?: string) {
        const errorName = typeof name === "string" && name.length > 0 ? name : "UnknownError"
        if (RECOVERABLE_ERROR_NAMES.has(errorName)) return
        // the idle-done challenge is delivered by aborting the in-flight
        // prompt first; that harness-initiated abort surfaces as a
        // MessageAbortedError and must not be scored as a fatal run error.
        // Exactly ONE such abort exists per challenge — later aborts are real.
        if (idleDoneChallengeTurn !== undefined && !challengeAbortSuppressed && errorName === "MessageAbortedError") {
          challengeAbortSuppressed = true
          return
        }
        fatalError = {
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
          const data = (info.error.data ?? {}) as Record<string, unknown>
          this.onSessionError(info.error.name, typeof data.message === "string" ? data.message : undefined)
          return
        }
        if (info.finish === "error" || info.finish === "other") {
          // the terminal message of the ONE prompt the idle-done fallback
          // aborted (to deliver its challenge) finishes abnormally by design;
          // any further abnormal finish is a real failure.
          if (idleDoneChallengeTurn !== undefined && !challengeFinishSuppressed) {
            challengeFinishSuppressed = true
            return
          }
          fatalError ??= { name: `AbnormalFinish:${info.finish}`, timeout: false }
        }
      },
      /** True when the run ended by fatal abort — the process must exit nonzero. */
      get fatal() {
        return budgetExhausted || fatalError !== undefined
      },
      /** Dual-attribution fields + done_reason for the run record/output. */
      termination(): Termination {
        const model: WhyModelStopped = (() => {
          if (lastFinishReason === "stop" && lastTextExplicitDone) return "explicit-done"
          if (lastFinishReason === "tool-calls" || lastFinishReason === "tool-call") return "tool-call"
          return "stop"
        })()
        // A completion assertion requires finishReason "stop" PLUS
        // the explicit DONE token — never bare "stop". If the assertion followed
        // the idle-done confirm challenge, it is honestly attributed to the
        // heuristic, not to unprompted model completion.
        const done: DoneReason = (() => {
          if (lastFinishReason !== "stop" || !lastTextExplicitDone) return "none"
          // idle_heuristic only when the DONE landed in the challenge's own
          // generation (the turn it interrupted, or the reply turn right after).
          const challengeScoped =
            idleDoneChallengeTurn !== undefined &&
            lastExplicitDoneTurn !== undefined &&
            lastExplicitDoneTurn <= idleDoneChallengeTurn + 1
          return challengeScoped ? "idle_heuristic" : "explicit_done"
        })()
        const harness: WhyHarnessStopped = (() => {
          if (budgetExhausted) return "budget-exhausted"
          if (fatalError?.timeout) return "timeout"
          if (fatalError) return "error"
          // the session ended on (or after) the idle-done challenge.
          if (done === "idle_heuristic") return "idle-done"
          // A session that idles because the model finished is attributed to the
          // model, so the harness reason is "none".
          return "none"
        })()
        return { why_model_stopped: model, why_harness_stopped: harness, done_reason: done }
      },
    }
  }
  export type Info = ReturnType<typeof create>

  /**
   * Serialize a session error event's payload to a real name/message/status string.
   * Never returns a bare "[object Object]" or a literal "{}".
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

  /** Provider 5xx responses are retryable at the enqueue boundary. */
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
}
