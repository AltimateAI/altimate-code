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
    expect(["stop", "tool-call", "explicit-done", "length", "content-filter", "unknown"]).toContain(
      t.why_model_stopped,
    )
    expect(["budget-exhausted", "timeout", "error", "idle-done", "none"]).toContain(t.why_harness_stopped)
  })

  test("a run with no step-finish at all attributes model=unknown, not a false 'stop'", () => {
    // No onStepFinish call means lastFinishReason is undefined (e.g. a fatal abort
    // before any model output). Previously this fell through to a default "stop",
    // falsely claiming a clean model-side finish for a generation that never
    // completed.
    const acc = RunAccounting.create()
    expect(acc.termination().why_model_stopped).toBe("unknown")
  })

  test("length/content-filter finish reasons are attributed distinctly, not collapsed into stop", () => {
    for (const [reason, expected] of [
      ["length", "length"],
      ["content-filter", "content-filter"],
    ] as const) {
      const acc = RunAccounting.create()
      acc.onAssistantMessage({ id: "m1", agent: "build" })
      acc.onStepStart("m1")
      acc.onStepFinish("m1", reason)
      expect(acc.termination().why_model_stopped).toBe(expected)
    }
  })

  test("natural finish: model=stop, harness=none", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onStepStart("m1")
    acc.onStepFinish("m1", "stop")
    expect(acc.termination()).toEqual({ why_model_stopped: "stop", why_harness_stopped: "none" })
    expect(acc.fatal).toBe(false)
  })

  test("model still tool-calling when harness exhausts the budget", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onStepStart("m1")
    acc.onStepFinish("m1", "tool-calls")
    acc.onBudgetExhausted()
    expect(acc.termination()).toEqual({ why_model_stopped: "tool-call", why_harness_stopped: "budget-exhausted" })
    expect(acc.fatal).toBe(true)
  })

  test("explicit DONE assertion in the final text classifies as explicit-done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onText("m1", "All checks pass. DONE")
    acc.onStepFinish("m1", "stop")
    expect(acc.termination().why_model_stopped).toBe("explicit-done")
  })

  test("a negated DONE assertion is not classified as explicit-done", () => {
    for (const text of ["Still working on this. NOT DONE.", "I am not DONE", "not yet DONE"]) {
      const acc = RunAccounting.create()
      acc.onAssistantMessage({ id: "m1", agent: "build" })
      acc.onText("m1", text)
      acc.onStepFinish("m1", "stop")
      expect(acc.termination().why_model_stopped).toBe("stop")
    }
  })

  test("a trailing DONE after an earlier negated DONE still classifies as explicit-done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onText("m1", "The previous state was not DONE. DONE")
    acc.onStepFinish("m1", "stop")
    expect(acc.termination().why_model_stopped).toBe("explicit-done")
  })

  test("a trailing negated DONE after an earlier bare DONE is still not classified as explicit-done", () => {
    const acc = RunAccounting.create()
    acc.onAssistantMessage({ id: "m1", agent: "build" })
    acc.onText("m1", "DONE with step one, but overall not DONE")
    acc.onStepFinish("m1", "stop")
    expect(acc.termination().why_model_stopped).toBe("stop")
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

  // Regression: onPromptResult used to route a terminal ContextOverflowError through
  // onSessionError's recoverable-name filter — the same filter that (correctly) suppresses the
  // MID-RUN streamed overflow event, since auto-compaction usually recovers from that one. But
  // `info` here is the prompt() call's FINAL returned message: a ContextOverflowError reaching
  // this point means auto-compaction itself already gave up (SessionCompaction.process's
  // `result === "compact"` terminal path), so it must always be fatal, unlike the streamed case.
  test("a terminal ContextOverflowError (compaction itself gave up) is fatal, unlike the recoverable mid-run event", () => {
    const acc = RunAccounting.create()
    acc.onPromptResult({ finish: "error", error: { name: "ContextOverflowError", data: { message: "too large" } } })
    expect(acc.fatal).toBe(true)
    expect(acc.termination().why_harness_stopped).toBe("error")
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

  test("the FIRST fatal error is preserved when a second, unrelated error follows", () => {
    // A later cleanup/abort error (e.g. torn down after the original failure)
    // must not overwrite the root cause that actually stopped the run.
    const acc = RunAccounting.create()
    acc.onSessionError("UnknownError", "request timed out waiting for provider")
    acc.onSessionError("MessageAbortedError", "aborted during cleanup")
    expect(acc.termination().why_harness_stopped).toBe("timeout")
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
