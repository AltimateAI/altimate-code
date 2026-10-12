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
