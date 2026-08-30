// — honest turn accounting: compaction-machinery steps must not consume the
// --max-turns budget. (E4) — dual-attribution termination logging: every run
// records why_model_stopped AND why_harness_stopped as independent fields.
// — real error serialization (never a bare name, "[object Object]", or "{}").
import { describe, expect, test } from "bun:test"
import { RunAccounting } from "../../src/cli/cmd/run-accounting"

describe("RunAccounting turn accounting", () => {
  test("counts ordinary assistant steps", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "msg_1", agent: "build" })
    expect(acc.onStepStart("msg_1")).toBe(true)
    expect(acc.onStepStart("msg_1")).toBe(true)
    expect(acc.turnCount).toBe(2)
  })

  test("excludes compaction-machinery steps from turnCount", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "msg_work", agent: "build" })
    acc.onAssistantMessage({ id: "msg_compact", agent: "compaction" })
    expect(acc.onStepStart("msg_work")).toBe(true)
    expect(acc.onStepStart("msg_compact")).toBe(false)
    expect(acc.onStepStart("msg_compact")).toBe(false)
    expect(acc.onStepStart("msg_work")).toBe(true)
    expect(acc.turnCount).toBe(2)
  })

  test("a step whose owning message is unknown is counted (conservative default)", () => {
    const acc = RunAccounting.create()
    expect(acc.onStepStart("msg_unknown")).toBe(true)
    expect(acc.turnCount).toBe(1)
  })

  test("compaction steps do not perturb termination attribution", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "msg_work", agent: "build" })
    acc.onAssistantMessage({ id: "msg_compact", agent: "compaction" })
    acc.onStepFinish("msg_work", "stop")
    // compaction machinery finishing later must not overwrite the model's reason
    acc.onStepFinish("msg_compact", "tool-calls")
    acc.onText("msg_compact", "summary text\nDONE")
    expect(acc.termination().why_model_stopped).toBe("stop")
  })
})

describe("RunAccounting termination attribution (E4)", () => {
  test("both fields are always present with valid enum values", () => {
    const acc = RunAccounting.create()
    const t = acc.termination()
    expect(["stop", "tool-call", "explicit-done", "unknown"]).toContain(t.why_model_stopped)
    expect(["budget-exhausted", "timeout", "error", "idle-done", "none"]).toContain(t.why_harness_stopped)
  })

  test("natural finish: model=stop, harness=none", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onStepStart("m1")
    acc.onStepFinish("m1", "stop")
    expect(acc.termination()).toEqual({ why_model_stopped: "stop", why_harness_stopped: "none", done_reason: "none" })
    expect(acc.fatal).toBe(false)
  })

  test("model still tool-calling when harness exhausts the budget", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onStepStart("m1")
    acc.onStepFinish("m1", "tool-calls")
    acc.onBudgetExhausted()
    expect(acc.termination()).toEqual({
      why_model_stopped: "tool-call",
      why_harness_stopped: "budget-exhausted",
      done_reason: "none",
    })
    expect(acc.fatal).toBe(true)
  })

  test("explicit DONE assertion in the final text classifies as explicit-done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onText("m1", "All checks pass.\nDONE")
    acc.onStepFinish("m1", "stop")
    expect(acc.termination().why_model_stopped).toBe("explicit-done")
  })

  test("a later non-DONE text clears the explicit-done classification", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onText("m1", "DONE")
    acc.onText("m1", "actually, one more thing")
    acc.onStepFinish("m1", "stop")
    expect(acc.termination().why_model_stopped).toBe("stop")
  })

  test("fatal session error attributes harness=error and flips fatal", () => {
    const acc = RunAccounting.create()
    acc.onSessionError("APIError", "boom")
    expect(acc.termination().why_harness_stopped).toBe("error")
    expect(acc.fatal).toBe(true)
  })

  test("timeout-shaped session error attributes harness=timeout", () => {
    const acc = RunAccounting.create()
    acc.onSessionError("UnknownError", "request timed out waiting for provider")
    expect(acc.termination().why_harness_stopped).toBe("timeout")
  })

  test("ContextOverflowError is fatal until a completed compaction recovers it", () => {
    const acc = RunAccounting.create()
    acc.onSessionError("ContextOverflowError", "context window exceeded")
    expect(acc.fatal).toBe(true)
    expect(acc.termination().why_harness_stopped).toBe("error")
    acc.onCompactionRecovered()
    expect(acc.fatal).toBe(false)
    expect(acc.termination().why_harness_stopped).toBe("none")
  })

  test("no finish event reports an unknown model stop", () => {
    const acc = RunAccounting.create()
    expect(acc.termination().why_model_stopped).toBe("unknown")
  })

  test("terminal message with abnormal finish (error/other) is fatal (swallowed transport failure)", () => {
    for (const finish of ["error", "other"]) {
      const acc = RunAccounting.create()
      acc.onPromptResult({ finish })
      expect(acc.fatal).toBe(true)
      expect(acc.termination().why_harness_stopped).toBe("error")
    }
  })

  test("terminal message with a normal finish is not fatal", () => {
    for (const finish of ["stop", "length", "tool-calls", "content-filter", "unknown", undefined]) {
      const acc = RunAccounting.create()
      acc.onPromptResult({ finish })
      expect(acc.fatal).toBe(false)
    }
  })

  test("terminal message carrying an error field is fatal via the session-error path", () => {
    const acc = RunAccounting.create()
    acc.onPromptResult({ finish: "stop", error: { name: "APIError", data: { message: "boom" } } })
    expect(acc.fatal).toBe(true)
    expect(acc.termination().why_harness_stopped).toBe("error")
  })

  test("non-retryable SDK send errors without data.info are fatal", () => {
    const acc = RunAccounting.create()
    acc.onPromptSendError({ name: "BadRequestError", data: { message: "invalid request" } }, 400)
    expect(acc.fatal).toBe(true)
    expect(acc.termination().why_harness_stopped).toBe("error")
  })

  test("budget exhaustion takes precedence over a subsequent abort error", () => {
    const acc = RunAccounting.create()
    acc.onBudgetExhausted()
    acc.onSessionError("MessageAbortedError", "aborted")
    expect(acc.termination().why_harness_stopped).toBe("budget-exhausted")
  })
})

describe("RunAccounting.serializeSessionError", () => {
  test("composes name, status, and message", () => {
    expect(
      RunAccounting.serializeSessionError({ name: "APIError", data: { message: "upstream broke", status: 502 } }),
    ).toBe("APIError (status 502): upstream broke")
  })

  test("statusCode variant is picked up", () => {
    expect(RunAccounting.serializeSessionError({ name: "APIError", data: { message: "x", statusCode: 500 } })).toBe(
      "APIError (status 500): x",
    )
  })

  test("never returns a literal {} or [object Object]", () => {
    for (const input of [{}, { name: "", data: {} }, { name: "E", data: { message: { nested: true } } }, null, 7]) {
      const out = RunAccounting.serializeSessionError(input)
      expect(out).not.toBe("{}")
      expect(out).not.toContain("[object Object]")
      expect(out.length).toBeGreaterThan(0)
    }
  })

  test("name-only errors serialize to the name", () => {
    expect(RunAccounting.serializeSessionError({ name: "MessageOutputLengthError", data: {} })).toBe(
      "MessageOutputLengthError",
    )
  })

  // altimate_change start — upstream_fix regression: a native thrown Error
  // (e.g. a network/transport failure) has `.message` at the top level, not
  // nested under `.data`, and previously serialized to the bare error name.
  test("falls back to the top-level message on a native Error with no data.message", () => {
    expect(RunAccounting.serializeSessionError(new TypeError("fetch failed"))).toBe("TypeError: fetch failed")
  })

  test("data.message still wins over the top-level message when both are present", () => {
    expect(
      RunAccounting.serializeSessionError({ name: "APIError", message: "generic", data: { message: "specific" } }),
    ).toBe("APIError: specific")
  })
  // altimate_change end
})

// altimate_change start — PR #1171 review: the turn budget was accepted unvalidated.
describe("RunAccounting.isValidMaxTurns", () => {
  test("accepts positive integers", () => {
    expect(RunAccounting.isValidMaxTurns(1)).toBe(true)
    expect(RunAccounting.isValidMaxTurns(40)).toBe(true)
  })

  test("rejects NaN — a non-numeric value is falsy and silently disabled the budget", () => {
    expect(RunAccounting.isValidMaxTurns(Number.NaN)).toBe(false)
  })

  test("rejects zero and negatives — a negative budget tripped on the very first step", () => {
    expect(RunAccounting.isValidMaxTurns(0)).toBe(false)
    expect(RunAccounting.isValidMaxTurns(-5)).toBe(false)
  })

  test("rejects fractional, infinite and non-numeric values", () => {
    expect(RunAccounting.isValidMaxTurns(2.5)).toBe(false)
    expect(RunAccounting.isValidMaxTurns(Infinity)).toBe(false)
    expect(RunAccounting.isValidMaxTurns("3")).toBe(false)
    expect(RunAccounting.isValidMaxTurns(undefined)).toBe(false)
  })
})
// altimate_change end

describe("RunAccounting retry classification", () => {
  test("5xx statuses are retryable; 4xx and non-numbers are not", () => {
    expect(RunAccounting.isRetryableStatus(500)).toBe(true)
    expect(RunAccounting.isRetryableStatus(503)).toBe(true)
    expect(RunAccounting.isRetryableStatus(400)).toBe(false)
    expect(RunAccounting.isRetryableStatus(404)).toBe(false)
    expect(RunAccounting.isRetryableStatus(undefined)).toBe(false)
  })

  test("timeouts and dropped connections are retryable thrown errors", () => {
    expect(RunAccounting.isRetryableThrown(new Error("request timed out"))).toBe(true)
    expect(RunAccounting.isRetryableThrown(Object.assign(new Error("io"), { code: "ECONNRESET" }))).toBe(true)
    expect(RunAccounting.isRetryableThrown(new Error("fetch failed"))).toBe(true)
    expect(RunAccounting.isRetryableThrown(new Error("model not found"))).toBe(false)
    expect(RunAccounting.isRetryableThrown(undefined)).toBe(false)
  })

  test("backoff grows exponentially but never exceeds the timer ceiling", () => {
    expect(RunAccounting.retryDelayMs(1000, 0)).toBe(1000)
    expect(RunAccounting.retryDelayMs(1000, 3)).toBe(8000)
    // The accepted env maximums (base 60s, 20 retries) compound past the signed
    // 32-bit limit; an unclamped delay there is scheduled for ~1ms, which turns
    // the backoff into a tight retry loop.
    expect(60_000 * 2 ** 19).toBeGreaterThan(RunAccounting.MAX_TIMER_MS)
    expect(RunAccounting.retryDelayMs(60_000, 19)).toBe(RunAccounting.MAX_TIMER_MS)
    for (let attempt = 0; attempt <= 20; attempt++) {
      expect(RunAccounting.retryDelayMs(60_000, attempt)).toBeLessThanOrEqual(RunAccounting.MAX_TIMER_MS)
    }
  })
})

describe("RunAccounting done_reason + idle-done bookkeeping", () => {
  test("bare finishReason stop is NEVER reported as done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onText("m1", "Let me now read the schema file.")
    acc.onStepFinish("m1", "stop")
    expect(acc.termination().done_reason).toBe("none")
  })

  test("unprompted stop+DONE reports done_reason=explicit_done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onText("m1", "All checks green.\nDONE")
    acc.onStepFinish("m1", "stop")
    const t = acc.termination()
    expect(t.done_reason).toBe("explicit_done")
    expect(t.why_model_stopped).toBe("explicit-done")
    expect(t.why_harness_stopped).toBe("none")
  })

  test("synthetic text appended after DONE does not clear explicit-DONE attribution", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "plan" })
    acc.onStepStart("m1")
    acc.onText("m1", "Plan is complete.\nDONE")
    acc.onText("m1", "altimate-code: plan agent stopped without writing a plan", true)
    acc.onStepFinish("m1", "stop")
    expect(acc.termination().done_reason).toBe("explicit_done")
  })

  test("DONE elicited by the idle-done challenge reports idle_heuristic + harness idle-done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onIdleDoneChallengeIssued()
    acc.onIdleDoneChallengeReplySent()
    acc.onText("m1", "Confirmed.\nDONE")
    acc.onStepFinish("m1", "stop")
    acc.onIdleDoneChallengeCompleted()
    const t = acc.termination()
    expect(t.done_reason).toBe("idle_heuristic")
    expect(t.why_harness_stopped).toBe("idle-done")
    expect(acc.fatal).toBe(false)
  })

  test("challenge issued but model continues without DONE: done_reason=none, harness=none", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onIdleDoneChallengeIssued()
    acc.onIdleDoneChallengeReplySent()
    acc.onText("m1", "Remaining: wire the config flag. Continuing.")
    acc.onStepFinish("m1", "stop")
    acc.onIdleDoneChallengeCompleted()
    const t = acc.termination()
    expect(t.done_reason).toBe("none")
    expect(t.why_harness_stopped).toBe("none")
  })

  test("the harness-initiated challenge abort is not scored as a fatal error", () => {
    const acc = RunAccounting.create()
    acc.onIdleDoneChallengeIssued()
    acc.onSessionError("MessageAbortedError", "aborted")
    acc.onPromptResult({ finish: "error" })
    expect(acc.fatal).toBe(false)
    expect(acc.termination().why_harness_stopped).toBe("none")
  })

  test("regression: an exhausted challenge send is fatal — the run must not exit 0", () => {
    // The confirm-DONE challenge never reached the model: completion was NOT
    // confirmed, so the run exits nonzero with harness attribution "error".
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onText("m1", "still churning")
    acc.onStepFinish("m1", "stop")
    acc.onIdleDoneChallengeIssued()
    acc.onSessionError("IdleDoneChallengeFailed", "idle-done challenge prompt failed: ProviderError(503)")
    expect(acc.fatal).toBe(true)
    const t = acc.termination()
    expect(t.why_harness_stopped).toBe("error")
    expect(t.done_reason).toBe("none")
  })

  test("an abort BEFORE any challenge is still fatal (guard is challenge-scoped)", () => {
    const acc = RunAccounting.create()
    acc.onSessionError("MessageAbortedError", "aborted")
    expect(acc.fatal).toBe(true)
  })

  test("unprompted DONE generations after a declined challenge report explicit_done", () => {
    // Challenge at turn N; the model declines, does two more full turns of
    // work, then asserts DONE on its own — that is honest explicit_done, not
    // the heuristic's doing.
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onStepStart("m1")
    acc.onIdleDoneChallengeIssued()
    acc.onIdleDoneChallengeReplySent()
    acc.onText("m1", "Remaining: wire the config flag. Continuing.")
    acc.onStepFinish("m1", "stop")
    acc.onIdleDoneChallengeCompleted()
    acc.onAssistantMessage({ id: "m2", agent: "build" })
    acc.onStepStart("m2")
    acc.onStepFinish("m2", "tool-calls")
    acc.onAssistantMessage({ id: "m3", agent: "build" })
    acc.onStepStart("m3")
    acc.onText("m3", "All checks green.\nDONE")
    acc.onStepFinish("m3", "stop")
    const t = acc.termination()
    expect(t.done_reason).toBe("explicit_done")
    expect(t.why_harness_stopped).toBe("none")
  })

  test("a challenge reply may use tools before DONE and remains idle_heuristic", () => {
    const acc = RunAccounting.create()
    acc.onIdleDoneChallengeIssued()
    acc.onIdleDoneChallengeReplySent()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onStepStart("m1")
    acc.onStepFinish("m1", "tool-calls")
    acc.onAssistantMessage({ id: "m2", agent: "build" })
    acc.onStepStart("m2")
    acc.onText("m2", "Verified.\nDONE")
    acc.onStepFinish("m2", "stop")
    acc.onIdleDoneChallengeCompleted()
    expect(acc.termination()).toEqual({
      why_model_stopped: "explicit-done",
      why_harness_stopped: "idle-done",
      done_reason: "idle_heuristic",
    })
  })

  // altimate_change start — upstream_fix regression: onText/onStepFinish are
  // independently overwritten by whichever message last fired each event. A
  // DONE-bearing message that finishes "tool-calls" followed by a textless
  // message that finishes "stop" must NOT pair the stale DONE flag from the
  // FIRST message with the finish reason of the SECOND.
  test("stale DONE from a tool-calls message is not paired with a later textless stop", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onStepStart("m1")
    acc.onText("m1", "Wrapping up.\nDONE")
    acc.onStepFinish("m1", "tool-calls")
    acc.onAssistantMessage({ id: "m2", agent: "build" })
    acc.onStepStart("m2")
    acc.onStepFinish("m2", "stop") // no onText for m2 — no text part at all
    const t = acc.termination()
    expect(t.done_reason).toBe("none")
    expect(t.why_model_stopped).toBe("stop")
  })
  // altimate_change end

  test("only ONE harness abort is forgiven per challenge — a second abort is fatal", () => {
    const acc = RunAccounting.create()
    acc.onIdleDoneChallengeIssued()
    acc.onSessionError("MessageAbortedError", "aborted")
    expect(acc.fatal).toBe(false)
    acc.onSessionError("MessageAbortedError", "aborted again")
    expect(acc.fatal).toBe(true)
  })

  test("a real error during the challenge continuation still wins over idle-done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onIdleDoneChallengeIssued()
    acc.onIdleDoneChallengeReplySent()
    acc.onText("m1", "DONE")
    acc.onStepFinish("m1", "stop")
    acc.onSessionError("APIError", "boom")
    expect(acc.termination().why_harness_stopped).toBe("error")
    expect(acc.fatal).toBe(true)
  })

  // altimate_change start — upstream_fix regression: the interrupted prompt's
  // abort can surface as EITHER onSessionError(MessageAbortedError) or an
  // abnormal onPromptResult (or both) — both suppressions above are scoped to
  // that one abort. Once the challenge reply itself has been sent, a genuine
  // failure of the reply must not be absorbed by whichever suppression the
  // interrupted prompt's abort left unused.
  test("a genuine challenge-reply failure is fatal even if the interrupted prompt's abort only used one suppression channel", () => {
    const acc = RunAccounting.create()
    acc.onIdleDoneChallengeIssued()
    // The interrupted prompt's abort surfaces ONLY via onSessionError — its
    // own onPromptResult never reports an abnormal finish (e.g. it resolved
    // "stop" before the abort landed), so challengeFinishSuppressed is never
    // consumed here.
    acc.onSessionError("MessageAbortedError", "aborted")
    expect(acc.fatal).toBe(false)
    // The challenge reply is now sent; its own errorless abnormal finish is a
    // real failure of the confirmation, not a leftover of the abort above.
    acc.onIdleDoneChallengeReplySent()
    acc.onPromptResult({ finish: "other" })
    expect(acc.fatal).toBe(true)
    expect(acc.termination().why_harness_stopped).toBe("error")
  })

  test("both suppression channels still forgive the same interrupted-prompt abort before the reply is sent", () => {
    const acc = RunAccounting.create()
    acc.onIdleDoneChallengeIssued()
    acc.onSessionError("MessageAbortedError", "aborted")
    acc.onPromptResult({ finish: "error" })
    expect(acc.fatal).toBe(false)
  })
  // altimate_change end
})

// altimate_change start — source-level lifecycle contracts for the run command.
// The generated SDK and embedded server make these races expensive to induce in
// a unit test; pin the critical signal/phase wiring alongside behavioral
// accounting tests so a refactor cannot silently detach it.
describe("run command request/stream lifecycle contracts", () => {
  test("the initial synchronous request shares and is cancelled by the SSE lifetime", async () => {
    const source = await Bun.file(new URL("../../src/cli/cmd/run.ts", import.meta.url).pathname).text()
    expect(source).toMatch(
      /const loopPromise = loop\(events\.stream,[\s\S]*?\.catch\(\(e\) => \{[\s\S]*?eventAbort\.abort\(\)/,
    )
    expect(source).toMatch(/sdk\.session\.command\([\s\S]*?\{ signal: eventAbort\.signal \},\s*\)/)
    expect(source).toMatch(/sdk\.session\.prompt\([\s\S]*?\{ signal: eventAbort\.signal \},\s*\)/)
  })

  test("abort suppression is initial-stream-only and a declined challenge enqueues continuation", async () => {
    const source = await Bun.file(new URL("../../src/cli/cmd/run.ts", import.meta.url).pathname).text()
    expect(source).toContain("options?.suppressInterruptedPromptAbort")
    expect(source).toContain('loop(events.stream, { suppressInterruptedPromptAbort: true })')
    expect(source).toContain("SessionTermination.CONTINUE_AFTER_DECLINED_CHALLENGE")
    expect(source).toContain('"IdleDoneContinuationUnconfirmed"')
  })
})
// altimate_change end
