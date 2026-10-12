import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { RunAccounting } from "@/cli/cmd/run-accounting"
import { SessionTermination } from "@/session/termination"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

function exhausted() {
  const accounting = RunAccounting.create()
  accounting.onStepStart("work")
  accounting.onStepFinish("work", "tool-calls")
  accounting.onStepStart("interrupted")
  accounting.onBudgetExhausted()
  return accounting
}

describe("budget finalization accounting", () => {
  // altimate_change start — distinguish recovered wall-clock limits from turn limits and real failures
  test("a successful time-budget finalization clears fatal status but keeps budget attribution", () => {
    const accounting = RunAccounting.create()
    accounting.onStepStart("interrupted")
    accounting.onBudgetExhausted("time")
    accounting.onSessionError("MessageAbortedError", "intentional time-budget abort")
    accounting.onPromptResult({ error: { name: "MessageAbortedError" } })
    expect(accounting.fatal).toBe(true)
    expect(accounting.takeBudgetFinalizationAllowance()).toBe(2)
    accounting.onStepStart("finalization")
    accounting.onText("finalization", "The evidence supports a limited answer.")
    accounting.onStepFinish("finalization", "stop")
    accounting.onPromptResult({ finish: "stop" })

    expect(accounting.completeBudgetFinalization(true)).toBe(true)
    expect(accounting.fatal).toBe(false)
    expect(accounting.takeBudgetFinalizationAllowance()).toBeUndefined()
    expect(accounting.termination()).toEqual({
      why_model_stopped: "stop",
      why_harness_stopped: "budget-exhausted",
      done_reason: "none",
    })
  })

  test("a silent time-budget finalization keeps the run fatal", () => {
    const accounting = RunAccounting.create()
    accounting.onBudgetExhausted("time")
    expect(accounting.takeBudgetFinalizationAllowance()).toBe(1)
    accounting.onPromptResult({ finish: "stop" })
    expect(accounting.completeBudgetFinalization(false)).toBe(false)
    expect(accounting.fatal).toBe(true)
  })

  test("an answer cannot recover a time budget until the finalization allowance was taken", () => {
    const accounting = RunAccounting.create()
    accounting.onBudgetExhausted("time")
    expect(accounting.completeBudgetFinalization(true)).toBe(false)
    expect(accounting.fatal).toBe(true)
  })

  test("successful turn-budget finalization preserves the existing nonzero exit contract", () => {
    const accounting = exhausted()
    expect(accounting.takeBudgetFinalizationAllowance()).toBe(3)
    expect(accounting.completeBudgetFinalization(true)).toBe(false)
    expect(accounting.fatal).toBe(true)
  })

  test.each(["APIError", "MessageAbortedError", "ContextOverflowError"])(
    "%s during time-budget finalization cannot be hidden by a partial answer",
    (name) => {
      const accounting = RunAccounting.create()
      accounting.onBudgetExhausted("time")
      expect(accounting.takeBudgetFinalizationAllowance()).toBe(1)
      accounting.onSessionError(name, "finalization failed")
      expect(accounting.completeBudgetFinalization(true)).toBe(false)
      expect(accounting.fatal).toBe(true)
    },
  )

  test("an abnormal finalization finish cannot be hidden by a partial answer", () => {
    const accounting = RunAccounting.create()
    accounting.onBudgetExhausted("time")
    expect(accounting.takeBudgetFinalizationAllowance()).toBe(1)
    accounting.onPromptResult({ finish: "other" })
    expect(accounting.completeBudgetFinalization(true)).toBe(false)
    expect(accounting.fatal).toBe(true)
  })
  // altimate_change end

  test("grants one local generation without resetting the exhausted budget", () => {
    const accounting = exhausted()
    accounting.onSessionError("MessageAbortedError", "aborted by the turn limit")
    accounting.onPromptResult({ error: { name: "MessageAbortedError" } })

    expect(accounting.takeBudgetFinalizationAllowance()).toBe(3)
    expect(accounting.takeBudgetFinalizationAllowance()).toBeUndefined()
    expect(accounting.turnCount).toBe(2)
    expect(accounting.fatal).toBe(true)

    accounting.onStepStart("finalization")
    accounting.onText("finalization", "The supported result is available; verification is incomplete.")
    accounting.onStepFinish("finalization", "stop")
    expect(accounting.turnCount).toBe(3)
    expect(accounting.termination()).toEqual({
      why_model_stopped: "stop",
      why_harness_stopped: "budget-exhausted",
      done_reason: "none",
    })
  })

  test("does not grant an allowance before a budget abort", () => {
    const accounting = RunAccounting.create()
    accounting.onStepStart("work")
    expect(accounting.takeBudgetFinalizationAllowance()).toBeUndefined()
    expect(accounting.fatal).toBe(false)
  })

  for (const finish of ["error", "other"]) {
    test(`accepts one interrupted prompt result with finish=${finish}`, () => {
      const accounting = exhausted()
      accounting.onSessionError("MessageAbortedError", "aborted")
      accounting.onPromptResult({ finish })
      expect(accounting.takeBudgetFinalizationAllowance()).toBe(3)
    })
  }

  for (const name of ["APIError", "TransportError", "ContextOverflowError"]) {
    for (const order of ["before", "after"] as const) {
      test(`${name} ${order} budget exhaustion prevents a finalization despite reason precedence`, () => {
        const accounting = RunAccounting.create()
        accounting.onStepStart("work")
        if (order === "before") accounting.onSessionError(name, "genuine failure")
        accounting.onBudgetExhausted()
        if (order === "after") accounting.onSessionError(name, "genuine failure")
        accounting.onSessionError("MessageAbortedError", "intentional abort")
        accounting.onPromptResult({ error: { name: "MessageAbortedError" } })
        expect(accounting.takeBudgetFinalizationAllowance()).toBeUndefined()
        expect(accounting.termination().why_harness_stopped).toBe("budget-exhausted")
      })
    }
  }

  test("a genuine abnormal result before the budget abort prevents finalization", () => {
    const accounting = RunAccounting.create()
    accounting.onPromptResult({ finish: "other" })
    accounting.onBudgetExhausted()
    expect(accounting.takeBudgetFinalizationAllowance()).toBeUndefined()
  })

  test("a failed prompt transport prevents finalization", () => {
    const accounting = exhausted()
    accounting.onPromptSendError(new Error("connection reset"))
    expect(accounting.takeBudgetFinalizationAllowance()).toBeUndefined()
  })

  test("a second abort on either channel is not forgiven", () => {
    const event = exhausted()
    event.onSessionError("MessageAbortedError", "intentional abort")
    event.onSessionError("MessageAbortedError", "another abort")
    expect(event.takeBudgetFinalizationAllowance()).toBeUndefined()

    const prompt = exhausted()
    prompt.onPromptResult({ error: { name: "MessageAbortedError" } })
    prompt.onPromptResult({ error: { name: "MessageAbortedError" } })
    expect(prompt.takeBudgetFinalizationAllowance()).toBeUndefined()
  })

  test("an earlier idle-done challenge does not consume the budget abort allowance", () => {
    const accounting = RunAccounting.create()
    accounting.onIdleDoneChallengeIssued()
    accounting.onSessionError("MessageAbortedError", "challenge interruption")
    accounting.onPromptResult({ finish: "other" })
    accounting.onIdleDoneChallengeReplySent()
    accounting.onIdleDoneChallengeCompleted()
    accounting.onStepStart("continuation")
    accounting.onBudgetExhausted()
    accounting.onSessionError("MessageAbortedError", "budget interruption")
    accounting.onPromptResult({ error: { name: "MessageAbortedError" } })
    expect(accounting.takeBudgetFinalizationAllowance()).toBe(2)
    expect(accounting.termination().done_reason).toBe("none")
  })

  test("an idle-done reply failure cannot be hidden by later budget exhaustion", () => {
    const accounting = RunAccounting.create()
    accounting.onIdleDoneChallengeIssued()
    accounting.onSessionError("MessageAbortedError", "challenge interruption")
    accounting.onIdleDoneChallengeReplySent()
    accounting.onPromptResult({ finish: "other" })
    accounting.onIdleDoneChallengeCompleted()
    accounting.onBudgetExhausted()
    expect(accounting.takeBudgetFinalizationAllowance()).toBeUndefined()
  })
})

function isFinalization(body: Record<string, unknown>) {
  const messages = body.messages as { role?: string; content?: unknown }[] | undefined
  const lastUser = messages?.findLast((message) => message.role === "user")
  return JSON.stringify(lastUser?.content ?? "").includes(SessionTermination.REPLY_AFTER_BUDGET)
}

describe("opencode run: budget finalization subprocess", () => {
  // altimate_change start — exhausted budgets must disable execution even if the model calls a tool
  for (const budget of ["turn", "time"] as const) {
    cliIt.concurrent(
      `${budget}-budget finalization omits tools and rejects a model-requested write`,
      ({ llm, opencode, home }) =>
        Effect.gen(function* () {
          const forbidden = path.join(home, "after-budget.txt")
          yield* llm.tool("glob", { pattern: "*.sql", path: home })
          yield* llm.toolMatch(({ body }) => isFinalization(body), "write", {
            filePath: forbidden,
            content: "work continued after the hard budget",
          })
          yield* llm.pushMatch(({ body }) => !isFinalization(body), reply().hang())
          if (budget === "time") yield* llm.pushMatch(({ body }) => !isFinalization(body), reply().hang())
          const result = yield* opencode.run("Inspect SQL files and report the available evidence.", {
            format: "json",
            extraArgs: budget === "turn" ? ["--max-turns", "1"] : ["--time-budget", "5"],
            env: {
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                ...testProviderConfig(llm.url),
                permission: { glob: "allow", edit: "allow" },
              }),
            },
            timeoutMs: 60_000,
            bunRun: true,
          })
          expect(yield* Effect.promise(() => Bun.file(forbidden).exists())).toBe(false)
          const events = opencode.parseJsonEvents(result.stdout)
          const exhausted = events.filter((event) => event.type === "budget_exhausted")
          expect(exhausted).toHaveLength(1)
          expect(exhausted[0]).toMatchObject(budget === "turn" ? { limit: 1 } : { limit_seconds: 5 })
          expect(events.filter((event) => event.type === "tool_use").map((event) => event.part)).toContainEqual(
            expect.objectContaining({ tool: "glob", state: expect.objectContaining({ status: "completed" }) }),
          )
          const finalizations = (yield* llm.inputs).filter(isFinalization)
          expect(finalizations.length).toBeGreaterThanOrEqual(1)
          for (const request of finalizations) expect(request.tools ?? []).toEqual([])
        }),
      90_000,
    )
  }
  // altimate_change end

  cliIt.concurrent(
    "a silent stop exactly at --max-turns 1 gets one finalization and honors --no-trace",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const traceDir = path.join(home, "disabled-traces")
        yield* llm.text("")
        yield* llm.textMatch(({ body }) => isFinalization(body), "The evidence is insufficient to answer yet.")
        const result = yield* opencode.run("Give the supported answer.", {
          format: "json",
          extraArgs: ["--max-turns", "1", "--no-trace"],
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              tracing: { enabled: true, dir: traceDir, maxFiles: 0 },
            }),
          },
          timeoutMs: 60_000,
          bunRun: true,
        })
        opencode.expectExit(result, 1)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(1)
        expect(events.filter((event) => event.type === "termination")).toMatchObject([
          { why_model_stopped: "stop", why_harness_stopped: "budget-exhausted", done_reason: "none" },
        ])
        const answers = events
          .filter((event) => event.type === "text")
          .map((event) => (event.part as { text: string }).text)
          .filter((text) => text.trim())
        expect(answers).toEqual(["The evidence is insufficient to answer yet."])
        const requests = (yield* llm.inputs).filter(
          (body) => !JSON.stringify(body).includes("Generate a title for this conversation"),
        )
        expect(requests.filter((body) => !isFinalization(body))).toHaveLength(1)
        expect(requests.filter(isFinalization)).toHaveLength(1)
        expect(events.filter((event) => event.type === "trace_saved")).toHaveLength(0)
        yield* Effect.promise(async () => {
          await expect(fs.stat(traceDir)).rejects.toMatchObject({ code: "ENOENT" })
        })
      }),
    90_000,
  )

  cliIt.concurrent(
    "--max-turns 1 finalizes once from useful tool output and preserves JSON termination and exit 1",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const models = path.join(home, "models")
        yield* Effect.promise(() => fs.mkdir(models))
        yield* Effect.promise(() => Bun.write(path.join(models, "orders.sql"), "select 1\n"))
        yield* llm.tool("glob", { pattern: "*.sql", path: models })
        yield* llm.textMatch(({ body }) => isFinalization(body), "Found orders.sql; its contents remain unverified.")
        // The request whose step-start exceeds the budget may reach the provider.
        // Keep it separate from the finalization response and await its cancellation.
        yield* llm.pushMatch(({ body }) => !isFinalization(body), reply().hang())

        const result = yield* opencode.run("Which SQL files are present?", {
          format: "json",
          extraArgs: ["--max-turns", "1"],
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(llm.url), permission: { glob: "allow" } }),
          },
          timeoutMs: 60_000,
          bunRun: true,
        })
        opencode.expectExit(result, 1)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(1)
        expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(1)
        expect(events.filter((event) => event.type === "termination")).toMatchObject([
          { why_model_stopped: "stop", why_harness_stopped: "budget-exhausted", done_reason: "none" },
        ])
        expect(
          events.filter((event) => event.type === "text").map((event) => (event.part as { text: string }).text),
        ).toEqual(["Found orders.sql; its contents remain unverified."])
        const tools = events
          .filter((event) => event.type === "tool_use")
          .map(
            (event) =>
              event.part as {
                tool: string
                state: { status: string; output: string }
              },
          )
        expect(tools).toHaveLength(1)
        expect(tools[0]).toMatchObject({ tool: "glob", state: { status: "completed" } })
        expect(tools[0]!.state.output).toContain("orders.sql")
        const finalizations = (yield* llm.inputs).filter(isFinalization)
        expect(finalizations).toHaveLength(1)
        expect(JSON.stringify(finalizations[0])).toContain("orders.sql")
      }),
    90_000,
  )

  cliIt.concurrent(
    "a silent budget finalization produces an honest status once and exits 1",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("glob", { pattern: "*.sql" })
        yield* llm.textMatch(({ body }) => isFinalization(body), "")
        yield* llm.pushMatch(({ body }) => !isFinalization(body), reply().hang())
        const result = yield* opencode.run("Which SQL files are present?", {
          format: "json",
          extraArgs: ["--max-turns", "1"],
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(llm.url), permission: { glob: "allow" } }),
          },
          timeoutMs: 60_000,
          bunRun: true,
        })
        opencode.expectExit(result, 1)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(1)
        expect(events.filter((event) => event.type === "silent_turn")).toMatchObject([
          {
            message:
              "No final answer was produced: the work budget was exhausted and the best-effort reply did not provide an answer.",
          },
        ])
        expect(events.filter((event) => event.type === "termination")).toMatchObject([
          { why_harness_stopped: "budget-exhausted" },
        ])
        expect((yield* llm.inputs).filter(isFinalization)).toHaveLength(1)
      }),
    90_000,
  )

  cliIt.concurrent(
    "an answer within --max-turns 1 is not followed by another generation",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("The answer is ready.")
        const result = yield* opencode.run("Answer directly.", {
          format: "json",
          extraArgs: ["--max-turns", "1"],
          timeoutMs: 60_000,
          bunRun: true,
        })
        opencode.expectExit(result, 0)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(0)
        expect(events.filter((event) => event.type === "termination")).toMatchObject([{ why_harness_stopped: "none" }])
        const requests = (yield* llm.inputs).filter(
          (body) => !JSON.stringify(body).includes("Generate a title for this conversation"),
        )
        expect(requests).toHaveLength(1)
        expect(requests.filter(isFinalization)).toHaveLength(0)
      }),
    90_000,
  )
})

// altimate_change start — hard time-budget aborts recover only when finalization writes an answer
for (const finalAnswer of ["The available evidence supports this limited answer.", ""]) {
  cliIt.live(
    `hard time-budget finalization uses low effort and exits ${finalAnswer ? "0 with an answer" : "nonzero without an answer"}`,
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const outputPath = path.join(home, "answer.md")
        const config = testProviderConfig(llm.url)
        const model = config.provider.test.models["test-model"]
        yield* llm.push(reply().reason("Still considering the evidence.").hang())
        yield* llm.textMatch(({ body }) => isFinalization(body), finalAnswer)
        yield* llm.pushMatch(({ body }) => !isFinalization(body), reply().reason("More analysis.").hang())
        const result = yield* opencode.run("Give the best supported answer.", {
          format: "json",
          extraArgs: ["--time-budget", "5", "--variant", "high", "--output", outputPath],
          bunRun: true,
          env: {
            ALTIMATE_RUN_BUDGET_EFFORT_DOWNGRADE: "1",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...config,
              provider: {
                test: {
                  ...config.provider.test,
                  models: {
                    "test-model": {
                      ...model,
                      id: "o3",
                      reasoning: true,
                      variants: { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } },
                    },
                  },
                },
              },
              tracing: { enabled: true, dir: path.join(home, "traces"), maxFiles: 0 },
            }),
          },
          timeoutMs: 30_000,
        })
        const requests = (yield* llm.inputs).filter(
          (body) => !JSON.stringify(body).includes("Generate a title for this conversation"),
        )
        expect(requests).toHaveLength(3)
        expect(requests.map((body) => body.reasoning_effort)).toEqual(["high", "low", "low"])
        expect(JSON.stringify(requests[1])).toContain(SessionTermination.REPLY_BEFORE_TIME_BUDGET)
        expect(requests.filter(isFinalization)).toHaveLength(1)
        opencode.expectExit(result, finalAnswer ? 0 : 1)
        const output = yield* Effect.promise(() => Bun.file(outputPath).text())
        if (finalAnswer) {
          expect(output).toBe(finalAnswer)
          expect(result.stderr).toMatch(/warn|time.*budget|budget.*time/i)
        } else {
          expect(output).toContain("No final answer was produced")
        }
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(1)
        expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(1)
        expect(events.filter((event) => event.type === "termination")).toMatchObject([
          { why_harness_stopped: "budget-exhausted", time_budget_deadline: "hard" },
        ])
        const saved = events.filter((event) => event.type === "trace_saved")
        expect(saved).toHaveLength(1)
        const trace = yield* Effect.promise(() => Bun.file(saved[0]!.path as string).json())
        expect(trace.metadata.effort_downgraded_at).toBeDefined()
        expect(trace.metadata.generation_interrupted_at).toBeDefined()
        if (finalAnswer) {
          expect(trace.summary.status).toBe("completed")
          expect(trace.summary.error).toBeUndefined()
        }
        expect(yield* llm.pending).toBe(0)
      }),
    60_000,
  )
}
// altimate_change end
