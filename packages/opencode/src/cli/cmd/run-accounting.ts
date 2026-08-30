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
  export type WhyModelStopped = "stop" | "tool-call" | "explicit-done" | "unknown"
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

  // Timeout classification for why_harness_stopped="timeout" and retry decisions.
  const TIMEOUT_PATTERN = /\btimed?\s*out\b|\bETIMEDOUT\b|TimeoutError/i

  /** Holds only overflow errors whose trace status depends on later recovery. */
  export function createRecoverableOverflowTraceErrors() {
    let pending: string[] = []
    return {
      add(error: string) {
        pending.push(error)
      },
      recover() {
        pending = []
      },
      values() {
        return [...pending]
      },
    }
  }

  // the explicit model DONE assertion is the primary termination path.
  // Detection delegates to the SessionTermination completion-token contract —
  // the single detector shared with the processor stop-path and the idle-done
  // challenge, so instruction and detection can never drift apart.

  export function create() {
    const agents = new Map<string, string>()
    let turnCount = 0
    let lastFinishReason: string | undefined
    // altimate_change start — upstream_fix: onText and onStepFinish are
    // independently overwritten by whichever message last emitted a text/finish
    // event. A DONE-bearing message (finish="tool-calls") followed by a
    // textless message (finish="stop") left `lastTextExplicitDone` stale from
    // the FIRST message paired with `lastFinishReason` from the SECOND — cross-
    // message state, not one message's actual outcome. Track whose message each
    // came from and only trust the pairing when they agree.
    let lastFinishMessageID: string | undefined
    let lastTextMessageID: string | undefined
    // altimate_change end
    let lastTextExplicitDone = false
    let lastTextFromChallenge = false
    let budgetExhausted = false
    let fatalError: { name: string; timeout: boolean } | undefined
    // An overflow is recoverable only after compaction actually completes. In
    // particular, compaction can be disabled or its own summarizer can fail.
    let pendingContextOverflow = false
    // State for the one-shot confirm-DONE prompt. Attribution follows the
    // actual challenge request lifetime, not step counts: one reply may use
    // several tool-call steps before its final DONE assertion.
    let idleDoneChallengeIssued = false
    let challengeReplyActive = false
    // the harness delivers the challenge by aborting ONE in-flight prompt;
    // each suppression may fire at most once — later aborts/abnormal
    // finishes are real failures.
    let challengeAbortSuppressed = false
    let challengeFinishSuppressed = false
    // altimate_change start — upstream_fix: the abort of the interrupted prompt
    // can surface as onSessionError(MessageAbortedError), onPromptResult
    // (finish="error"/"other"), or both — either channel may fire for that
    // SAME abort, so both suppressions above are scoped to it. Once the
    // challenge reply itself is sent, a real failure there (e.g. an errorless
    // finish="other" on the confirm-DONE reply) must not be silently forgiven
    // by whichever suppression the interrupted prompt's abort left unused.
    let challengeReplySent = false
    // altimate_change end

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
        lastFinishMessageID = messageID
      },
      onText(messageID: string, text: string, synthetic = false) {
        if (isCompactionStep(messageID)) return
        if (synthetic) return
        lastTextExplicitDone = SessionTermination.isExplicitDone(text)
        lastTextMessageID = messageID
        lastTextFromChallenge = lastTextExplicitDone && challengeReplyActive
      },
      /** the idle-done fallback issued its one-shot confirm-DONE challenge. */
      onIdleDoneChallengeIssued() {
        idleDoneChallengeIssued = true
      },
      // altimate_change start — upstream_fix: see challengeReplySent above.
      /** the idle-done confirm-DONE challenge reply has been sent; suppression of the interrupted prompt's own abort no longer applies. */
      onIdleDoneChallengeReplySent() {
        challengeReplySent = true
        challengeReplyActive = true
      },
      /** Close the challenge generation after its synchronous prompt returns. */
      onIdleDoneChallengeCompleted() {
        challengeReplyActive = false
      },
      // altimate_change end
      onSessionError(name: unknown, message?: string) {
        const errorName = typeof name === "string" && name.length > 0 ? name : "UnknownError"
        if (errorName === "ContextOverflowError") {
          pendingContextOverflow = true
          return
        }
        // the idle-done challenge is delivered by aborting the in-flight
        // prompt first; that harness-initiated abort surfaces as a
        // MessageAbortedError and must not be scored as a fatal run error.
        // Exactly ONE such abort exists per challenge — later aborts are real.
        if (
          idleDoneChallengeIssued &&
          !challengeAbortSuppressed &&
          !challengeReplySent &&
          errorName === "MessageAbortedError"
        ) {
          challengeAbortSuppressed = true
          return
        }
        fatalError = {
          name: errorName,
          timeout: TIMEOUT_PATTERN.test(errorName) || TIMEOUT_PATTERN.test(message ?? ""),
        }
      },
      /** Confirm that a previously reported context overflow recovered. */
      onCompactionRecovered() {
        pendingContextOverflow = false
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
          if (idleDoneChallengeIssued && !challengeFinishSuppressed && !challengeReplySent) {
            challengeFinishSuppressed = true
            return
          }
          fatalError ??= { name: `AbnormalFinish:${info.finish}`, timeout: false }
        }
      },
      /** A non-2xx SDK response can carry `error` without a terminal message. */
      onPromptSendError(error: unknown, status?: number) {
        const detail = serializeSessionError(error)
        this.onSessionError("PromptRequestError", status ? `status ${status}: ${detail}` : detail)
      },
      /** True when the run ended by fatal abort — the process must exit nonzero. */
      get fatal() {
        return budgetExhausted || fatalError !== undefined || pendingContextOverflow
      },
      /** Dual-attribution fields + done_reason for the run record/output. */
      termination(): Termination {
        // altimate_change start — upstream_fix: only trust the DONE text when it
        // came from the SAME message as the finish reason being paired with it —
        // see the field comment above.
        const explicitDoneOnFinishMessage =
          lastTextExplicitDone && lastTextMessageID !== undefined && lastTextMessageID === lastFinishMessageID
        // altimate_change end
        const model: WhyModelStopped = (() => {
          if (lastFinishReason === "stop" && explicitDoneOnFinishMessage) return "explicit-done"
          if (lastFinishReason === "tool-calls" || lastFinishReason === "tool-call") return "tool-call"
          if (lastFinishReason === "stop") return "stop"
          return "unknown"
        })()
        // A completion assertion requires finishReason "stop" PLUS
        // the explicit DONE token — never bare "stop". If the assertion followed
        // the idle-done confirm challenge, it is honestly attributed to the
        // heuristic, not to unprompted model completion.
        const done: DoneReason = (() => {
          if (lastFinishReason !== "stop" || !explicitDoneOnFinishMessage) return "none"
          return lastTextFromChallenge ? "idle_heuristic" : "explicit_done"
        })()
        const harness: WhyHarnessStopped = (() => {
          if (budgetExhausted) return "budget-exhausted"
          if (fatalError?.timeout) return "timeout"
          if (fatalError || pendingContextOverflow) return "error"
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

  /** Production beforeExit state machine, factored so its rc contract is tested directly. */
  export function createBeforeExitGuard(proc: { exitCode?: string | number | null }, flush: () => void) {
    let finished = false
    return {
      onBeforeExit() {
        flush()
        if (!finished) proc.exitCode = 1
      },
      finish() {
        finished = true
        proc.exitCode = 0
      },
    }
  }

  /**
   * Serialize a session error event's payload to a real name/message/status string.
   * Never returns a bare "[object Object]" or a literal "{}".
   */
  export function serializeSessionError(error: unknown): string {
    if (error === undefined || error === null) return "UnknownError"
    if (typeof error !== "object") return String(error)
    const obj = error as { name?: unknown; message?: unknown; data?: unknown }
    const name = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : "UnknownError"
    const data = (obj.data && typeof obj.data === "object" ? obj.data : {}) as Record<string, unknown>
    const status =
      typeof data.status === "number" || (typeof data.status === "string" && data.status.length > 0)
        ? data.status
        : typeof data.statusCode === "number"
          ? data.statusCode
          : undefined
    // altimate_change start — upstream_fix: fall back to the top-level `message`
    // (native `Error.message`, e.g. thrown network/transport failures) when the
    // nested `data.message` the server-error shape uses is absent — otherwise a
    // thrown Error serialized to the bare string "Error" loses its message.
    const message =
      typeof data.message === "string" && data.message.length > 0
        ? data.message
        : typeof obj.message === "string" && obj.message.length > 0
          ? obj.message
          : data.message !== undefined
            ? JSON.stringify(data.message)
            : undefined
    // altimate_change end
    const head = status !== undefined ? `${name} (status ${status})` : name
    return message ? `${head}: ${message}` : head
  }

  /** Provider 5xx responses are retryable at the enqueue boundary. */
  export function isRetryableStatus(status: unknown): boolean {
    return typeof status === "number" && status >= 500 && status <= 599
  }

  /** setTimeout's signed 32-bit ceiling; a larger delay is clamped by the runtime to ~1ms. */
  export const MAX_TIMER_MS = 2_147_483_647

  /**
   * Exponential backoff clamped to the timer range. Bounding the retry count and
   * the base delay separately is NOT enough: at the accepted maximums the
   * compounded delay (base * 2**attempt) runs far past MAX_TIMER_MS, and an
   * overflowing timeout fires almost immediately — turning the backoff into the
   * tight retry loop the bounds exist to prevent.
   */
  export function retryDelayMs(baseMs: number, attempt: number): number {
    return Math.min(baseMs * 2 ** attempt, MAX_TIMER_MS)
  }

  /**
   * A `--max-turns` value the budget can actually enforce. yargs coerces a
   * non-numeric argument to NaN, which is falsy and silently DISABLES the
   * budget; a negative value is truthy and trips the check on the very first
   * step. Both are configuration errors, so the CLI rejects them up front
   * rather than running with a budget that does not mean what was asked.
   */
  export function isValidMaxTurns(value: unknown): boolean {
    return typeof value === "number" && Number.isInteger(value) && value >= 1
  }

  /** Thrown transport failures that warrant an enqueue retry: timeouts and dropped connections. */
  export function isRetryableThrown(error: unknown): boolean {
    if (error === undefined || error === null) return false
    const err = error as { name?: unknown; message?: unknown; code?: unknown }
    const text = [err.name, err.message, err.code].filter((v) => typeof v === "string").join(" ")
    return TIMEOUT_PATTERN.test(text) || /ECONNRESET|ECONNREFUSED|fetch failed|network error/i.test(text)
  }
}
