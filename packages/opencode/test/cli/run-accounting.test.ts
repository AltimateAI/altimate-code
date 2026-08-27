// W1.10 — honest turn accounting: compaction-machinery steps must not consume the
// --max-turns budget. W1.12 (E4) — dual-attribution termination logging: every run
// records why_model_stopped AND why_harness_stopped as independent fields.
// W1.1 — real error serialization (never a bare name, "[object Object]", or "{}").
import { describe, expect, test } from "bun:test"
import { RunAccounting } from "../../src/cli/cmd/run-accounting"

describe("RunAccounting turn accounting (W1.10)", () => {
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
    acc.onText("msg_compact", "summary text DONE")
    expect(acc.termination().why_model_stopped).toBe("stop")
  })
})

describe("RunAccounting termination attribution (W1.12 E4)", () => {
  test("both fields are always present with valid enum values", () => {
    const acc = RunAccounting.create()
    const t = acc.termination()
    expect(["stop", "tool-call", "explicit-done"]).toContain(t.why_model_stopped)
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
    expect(acc.termination()).toEqual({ why_model_stopped: "tool-call", why_harness_stopped: "budget-exhausted", done_reason: "none" })
    expect(acc.fatal).toBe(true)
  })

  test("explicit DONE assertion in the final text classifies as explicit-done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onText("m1", "All checks pass. DONE")
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

  test("recoverable ContextOverflowError does not flip fatal or the attribution", () => {
    // Auto-compaction recovers overflow; the error event alone must not change rc.
    const acc = RunAccounting.create()
    acc.onSessionError("ContextOverflowError", "context window exceeded")
    expect(acc.fatal).toBe(false)
    expect(acc.termination().why_harness_stopped).toBe("none")
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

  test("budget exhaustion takes precedence over a subsequent abort error", () => {
    const acc = RunAccounting.create()
    acc.onBudgetExhausted()
    acc.onSessionError("MessageAbortedError", "aborted")
    expect(acc.termination().why_harness_stopped).toBe("budget-exhausted")
  })
})

describe("RunAccounting.serializeSessionError (W1.1)", () => {
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
})

describe("RunAccounting retry classification (W1.1)", () => {
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
})

describe("RunAccounting done_reason + idle-done bookkeeping (W2.1)", () => {
  test("bare finishReason stop is NEVER reported as done (W2.1a)", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onText("m1", "Let me now read the schema file.")
    acc.onStepFinish("m1", "stop")
    expect(acc.termination().done_reason).toBe("none")
  })

  test("unprompted stop+DONE reports done_reason=explicit_done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onText("m1", "All checks green. DONE")
    acc.onStepFinish("m1", "stop")
    const t = acc.termination()
    expect(t.done_reason).toBe("explicit_done")
    expect(t.why_model_stopped).toBe("explicit-done")
    expect(t.why_harness_stopped).toBe("none")
  })

  test("DONE elicited by the idle-done challenge reports idle_heuristic + harness idle-done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onIdleDoneChallengeIssued()
    acc.onText("m1", "Confirmed. DONE")
    acc.onStepFinish("m1", "stop")
    const t = acc.termination()
    expect(t.done_reason).toBe("idle_heuristic")
    expect(t.why_harness_stopped).toBe("idle-done")
    expect(acc.fatal).toBe(false)
  })

  test("challenge issued but model continues without DONE: done_reason=none, harness=none", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onIdleDoneChallengeIssued()
    acc.onText("m1", "Remaining: wire the config flag. Continuing.")
    acc.onStepFinish("m1", "stop")
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

  test("an abort BEFORE any challenge is still fatal (guard is challenge-scoped)", () => {
    const acc = RunAccounting.create()
    acc.onSessionError("MessageAbortedError", "aborted")
    expect(acc.fatal).toBe(true)
  })

  test("a real error during the challenge continuation still wins over idle-done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onIdleDoneChallengeIssued()
    acc.onText("m1", "DONE")
    acc.onStepFinish("m1", "stop")
    acc.onSessionError("APIError", "boom")
    expect(acc.termination().why_harness_stopped).toBe("error")
    expect(acc.fatal).toBe(true)
  })
})
