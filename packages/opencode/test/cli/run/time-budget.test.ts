import { describe, expect, test } from "bun:test"
import { RunTimeBudget } from "../../../src/cli/cmd/run-time-budget"

describe("run time budget", () => {
  test.each([0, -1, -0.1, NaN, Infinity, -Infinity, "2", "", null, undefined, true, {}])(
    "rejects invalid seconds: %p",
    (value) => {
      expect(RunTimeBudget.isValidTimeBudget(value)).toBe(false)
    },
  )

  test.each([0.001, 0.5, 1, 900, Number.MAX_VALUE])("accepts positive finite seconds: %p", (value) => {
    expect(RunTimeBudget.isValidTimeBudget(value)).toBe(true)
  })

  test("does not fire when no budget is configured", () => {
    expect(RunTimeBudget.deadline(900, undefined)).toBeUndefined()
  })

  test.each([
    [0, undefined],
    [7.999, undefined],
    [8, "soft"],
    [9.999, "soft"],
    [10, "hard"],
    [20, "hard"],
  ] as const)("selects the deadline at %p elapsed seconds", (elapsed, expected) => {
    expect(RunTimeBudget.deadline(elapsed, 10)).toBe(expected)
  })

  test("handles fractional seconds without rounding away the budget", () => {
    expect(RunTimeBudget.deadline(0.399, 0.5)).toBeUndefined()
    expect(RunTimeBudget.deadline(0.4, 0.5)).toBe("soft")
    expect(RunTimeBudget.deadline(0.5, 0.5)).toBe("hard")
  })

  test("handles a large finite budget without overflowing deadline arithmetic", () => {
    expect(RunTimeBudget.deadline(Number.MAX_VALUE * 0.5, Number.MAX_VALUE)).toBeUndefined()
    expect(RunTimeBudget.deadline(Number.MAX_VALUE * 0.8, Number.MAX_VALUE)).toBe("soft")
    expect(RunTimeBudget.deadline(Number.MAX_VALUE, Number.MAX_VALUE)).toBe("hard")
  })
})

// altimate_change start — soft deadlines cancel a live generation and lower real provider request effort
import { Effect } from "effect"
import path from "node:path"
import { SessionTermination } from "../../../src/session/termination"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

function isSoftBudgetReply(body: Record<string, unknown>) {
  const messages = body.messages as { role?: string; content?: unknown }[] | undefined
  return JSON.stringify(messages?.findLast((message) => message.role === "user")?.content ?? "").includes(
    SessionTermination.REPLY_BEFORE_TIME_BUDGET,
  )
}

describe("opencode run: interrupt in-flight generation at soft time deadline", () => {
  for (const downgrade of [true, false]) {
    cliIt.live(
      `aborts a hanging generation, keeps emitted parts, and sends the nudge with ${downgrade ? "low" : "configured"} effort`,
      ({ llm, opencode, home }) =>
        Effect.gen(function* () {
          const outputPath = path.join(home, "answer.md")
          const config = testProviderConfig(llm.url)
          const model = config.provider.test.models["test-model"]
          const answer = "The supported answer is ready; further exploration was interrupted."
          const partial = "A useful observation before the deadline."
          yield* llm.push(reply().text(partial).reason("Still considering the evidence.").hang())
          yield* llm.textMatch(({ body }) => isSoftBudgetReply(body), answer)
          const result = yield* opencode.run("Give the best supported answer.", {
            format: "json",
            extraArgs: ["--time-budget", "5", "--variant", "high", "--output", outputPath],
            bunRun: true,
            env: {
              ALTIMATE_RUN_BUDGET_EFFORT_DOWNGRADE: downgrade ? "1" : "0",
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
          expect(requests).toHaveLength(2)
          expect(requests[0]!.reasoning_effort).toBe("high")
          expect(isSoftBudgetReply(requests[1]!)).toBe(true)
          expect(requests[1]!.reasoning_effort).toBe(downgrade ? "low" : "high")
          expect(JSON.stringify(requests[1])).toContain(partial)
          opencode.expectExit(result, 0)
          expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(answer)
          const events = opencode.parseJsonEvents(result.stdout)
          expect(events.filter((event) => event.type === "time_budget_warning")).toHaveLength(1)
          expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(0)
          expect(events.filter((event) => event.type === "error")).toHaveLength(0)
          const saved = events.filter((event) => event.type === "trace_saved")
          expect(saved).toHaveLength(1)
          const trace = yield* Effect.promise(() => Bun.file(saved[0]!.path as string).json())
          expect(trace.metadata).toMatchObject({ time_budget_s: 5, time_budget_deadline: "soft" })
          expect(trace.metadata.generation_interrupted_at).toBeDefined()
          if (downgrade) expect(trace.metadata.effort_downgraded_at).toBeDefined()
          else expect(trace.metadata.effort_downgraded_at).toBeUndefined()
          expect(trace.metadata.elapsed_s).toBeGreaterThanOrEqual(4)
          expect(trace.metadata.elapsed_s).toBeLessThan(5)
          expect(yield* llm.pending).toBe(0)
        }),
      60_000,
    )
  }
})
// altimate_change end
