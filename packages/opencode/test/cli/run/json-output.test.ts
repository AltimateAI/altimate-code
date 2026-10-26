import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import path from "node:path"
import type { TraceFile } from "../../../src/altimate/observability/tracing"
import { SessionTermination } from "../../../src/session/termination"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

function isBudgetFinalization(body: Record<string, unknown>) {
  const messages = body.messages as { role?: string; content?: unknown }[] | undefined
  const lastUser = messages?.findLast((message) => message.role === "user")
  return JSON.stringify(lastUser?.content ?? "").includes(SessionTermination.REPLY_AFTER_BUDGET)
}

function workRequests(inputs: Record<string, unknown>[]) {
  return inputs.filter((body) => !JSON.stringify(body).includes("Generate a title for this conversation"))
}

describe("opencode run: JSON output artifacts", () => {
  cliIt.concurrent(
    "--format json --output writes completed assistant text at termination and resolves root trace metadata",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const outputPath = path.join(home, "answer.md")
        const inputPath = path.join(home, "notes.txt")
        const preamble = "Let me read the project notes first."
        const answer = "The project notes contain three items."
        yield* Effect.promise(() => Bun.write(inputPath, "first\nsecond\nthird\n"))

        // Match the second generation by the read result, not HTTP call count:
        // background title generation can make its own request in either order.
        let reachedFinalGeneration!: () => void
        const finalGeneration = new Promise<void>((resolve) => {
          reachedFinalGeneration = resolve
        })
        let releaseAnswer!: () => void
        const answerGate = new Promise<void>((resolve) => {
          releaseAnswer = resolve
        })
        yield* llm.textTool(preamble, "read", { filePath: inputPath })
        yield* llm.pushMatch(({ body }) => {
          if (!Array.isArray(body.messages) || !body.messages.some((message) => message.role === "tool")) return false
          reachedFinalGeneration()
          return true
        }, reply().wait(answerGate).text(answer).stop())

        const config = {
          ...testProviderConfig(llm.url),
          model: "test/test-model",
          agent: { build: { model: "test/test-model", variant: "review" } },
          tracing: { enabled: true, dir: path.join(home, "traces"), maxFiles: 0 },
          experimental: { auto_mcp_discovery: false },
        }
        // Omit --model and --variant so this assertion depends on enrichment
        // from the root assistant, not metadata seeded from command-line flags.
        const running = yield* opencode
          .spawn(["run", "--agent", "build", "--format", "json", "--output", outputPath, "Summarize notes.txt."], {
            bunRun: true,
            env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), ALTIMATE_CLI_YOLO: "true" },
          })
          .pipe(Effect.forkChild)
        try {
          yield* Effect.promise(() => finalGeneration).pipe(Effect.timeout("45 seconds"))
          // --output holds the final step's text (the tool preamble belongs to an earlier
          // step) and writes once at normal termination. It is not a crash-durable stream.
          expect(yield* Effect.promise(() => Bun.file(outputPath).exists())).toBe(false)
        } finally {
          releaseAnswer()
        }
        const result = yield* Fiber.join(running)
        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(answer)

        const events = opencode.parseJsonEvents(result.stdout)
        const textEvents = events.filter((event) => event.type === "text")
        expect(textEvents.map((event) => (event.part as { text: string }).text)).toEqual([preamble, answer])
        const saved = events.filter((event) => event.type === "trace_saved")
        expect(saved).toHaveLength(1)
        expect(saved[0]!.sessionID).toBe(textEvents[0]!.sessionID)
        expect(typeof saved[0]!.path).toBe("string")
        const trace: TraceFile = yield* Effect.promise(() => Bun.file(saved[0]!.path as string).json())
        expect(trace.sessionId).toBe(textEvents[0]!.sessionID as string)
        expect(trace.metadata).toMatchObject({
          model: "test/test-model",
          providerId: "test",
          agent: "build",
          variant: "review",
        })
        expect(trace.summary.totalGenerations).toBe(2)
        expect(trace.summary.totalToolCalls).toBe(1)
        expect(yield* llm.pending).toBe(0)
      }),
    90_000,
  )

  cliIt.live(
    "--time-budget delivers one soft directive at the next slow-tool boundary",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const inputPath = path.join(home, "notes.txt")
        const outputPath = path.join(home, "answer.md")
        const answer = "The notes contain the current supported answer."
        yield* Effect.promise(() => Bun.write(inputPath, "current supported answer\n"))
        // The sleep is the workload being budgeted, not a synchronization delay.
        // Five seconds leaves headroom for prompt setup and the final read after
        // crossing the four-second soft deadline.
        yield* llm.tool("bash", { command: "sleep 4.05", description: "Simulate a slow exploration tool" })
        yield* llm.tool("read", { filePath: inputPath })
        yield* llm.text(answer)

        const result = yield* opencode.run("Read the notes and give the supported answer.", {
          format: "json",
          extraArgs: ["--time-budget", "5", "--output", outputPath],
          bunRun: true,
          env: {
            ALTIMATE_CLI_YOLO: "true",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              tracing: { enabled: true, dir: path.join(home, "traces"), maxFiles: 0 },
            }),
          },
        })
        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(answer)
        const requests = workRequests(yield* llm.inputs)
        expect(requests).toHaveLength(3)
        expect(JSON.stringify(requests[0])).not.toContain(SessionTermination.REPLY_BEFORE_TIME_BUDGET)
        expect(JSON.stringify(requests[1])).toContain(SessionTermination.REPLY_BEFORE_TIME_BUDGET)
        expect(JSON.stringify(requests[2]).split(SessionTermination.REPLY_BEFORE_TIME_BUDGET)).toHaveLength(2)
        expect(requests.filter(isBudgetFinalization)).toHaveLength(0)

        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "time_budget_warning")).toMatchObject([{ limit_seconds: 5 }])
        expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(0)
        // altimate_change start — the soft deadline preserves a tool result after it finishes
        const tools = events.filter((event) => event.type === "tool_use").map((event) => event.part)
        expect(tools).toHaveLength(2)
        expect(tools[0]).toMatchObject({ tool: "bash", state: { status: "completed" } })
        expect(tools[1]).toMatchObject({ tool: "read", state: { status: "completed" } })
        expect(JSON.stringify(requests[2])).toContain("current supported answer")
        // altimate_change end
        expect(events.filter((event) => event.type === "termination")).toMatchObject([
          { why_harness_stopped: "none", time_budget_s: 5, time_budget_deadline: "soft" },
        ])
        const saved = events.filter((event) => event.type === "trace_saved")
        expect(saved).toHaveLength(1)
        const trace: TraceFile = yield* Effect.promise(() => Bun.file(saved[0]!.path as string).json())
        expect(trace.metadata).toMatchObject({ time_budget_s: 5, time_budget_deadline: "soft" })
        expect(trace.metadata.elapsed_s).toBeGreaterThanOrEqual(4)
        expect(trace.metadata.elapsed_s).toBeLessThan(5)
        expect(yield* llm.pending).toBe(0)
      }),
    90_000,
  )

  for (const finalAnswer of ["The notes establish three items; the additional exploration was interrupted.", ""]) {
    cliIt.live(
      `--time-budget cuts off a running tool and finalizes once (${finalAnswer ? "partial answer" : "no answer"})`,
      ({ llm, home, opencode }) =>
        Effect.gen(function* () {
          const inputPath = path.join(home, "notes.txt")
          const outputPath = path.join(home, "answer.md")
          yield* Effect.promise(() => Bun.write(inputPath, "The notes establish three items.\n"))
          yield* llm.tool("read", { filePath: inputPath })
          yield* llm.textTool("Let me explore a little further before answering.", "bash", {
            command: "sleep 10",
            description: "Simulate exploration beyond the deadline",
          })
          yield* llm.textMatch(({ body }) => isBudgetFinalization(body), finalAnswer)
          // If the interrupted tool races a further work request, keep that
          // request from consuming the one finalization response.
          yield* llm.pushMatch(({ body }) => !isBudgetFinalization(body), reply().hang())
          const result = yield* opencode.run("Read the notes and investigate further.", {
            format: "json",
            extraArgs: ["--output", outputPath],
            bunRun: true,
            env: {
              ALTIMATE_RUN_TIME_BUDGET_S: "2",
              ALTIMATE_CLI_YOLO: "true",
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                ...testProviderConfig(llm.url),
                tracing: { enabled: true, dir: path.join(home, "traces"), maxFiles: 0 },
              }),
            },
          })
          // altimate_change start — a hard deadline is recovered when finalization writes the answer
          opencode.expectExit(result, finalAnswer ? 0 : 1)
          // altimate_change end
          const events = opencode.parseJsonEvents(result.stdout)
          expect(events.filter((event) => event.type === "budget_exhausted")).toMatchObject([{ limit_seconds: 2 }])
          expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(1)
          expect(events.filter((event) => event.type === "termination")).toMatchObject([
            { why_harness_stopped: "budget-exhausted", time_budget_s: 2, time_budget_deadline: "hard" },
          ])
          const finalizations = workRequests(yield* llm.inputs).filter(isBudgetFinalization)
          expect(finalizations).toHaveLength(1)
          expect(JSON.stringify(finalizations[0])).toContain("The notes establish three items.")
          const saved = events.filter((event) => event.type === "trace_saved")
          expect(saved).toHaveLength(1)
          const trace: TraceFile = yield* Effect.promise(() => Bun.file(saved[0]!.path as string).json())
          expect(trace.metadata).toMatchObject({ time_budget_s: 2, time_budget_deadline: "hard" })
          expect(trace.metadata.elapsed_s).toBeGreaterThanOrEqual(2)
          // A natural tool finish would take ten seconds. Exclude process boot
          // from the measurement by asserting the run's own elapsed accounting.
          expect(trace.metadata.elapsed_s).toBeLessThan(10)
          const output = yield* Effect.promise(() => Bun.file(outputPath).text())
          if (finalAnswer) {
            expect(output).toBe(finalAnswer)
            expect(events.filter((event) => event.type === "silent_turn")).toHaveLength(0)
          } else {
            expect(output).toBe(
              "No final answer was produced: the work budget was exhausted and the best-effort reply did not provide an answer.",
            )
            expect(events.filter((event) => event.type === "silent_turn")).toHaveLength(1)
          }
        }),
      90_000,
    )
  }

  cliIt.live(
    "time exhaustion during a silent-turn followup still gets one budget finalization",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const answer = "There is not enough evidence to answer; the attempted exploration was interrupted."
        const outputPath = path.join(home, "answer.md")
        yield* llm.text("")
        yield* llm.textTool("Let me investigate before giving the requested reply.", "bash", {
          command: "sleep 10",
          description: "Simulate exploration in the silent-turn followup",
        })
        yield* llm.textMatch(({ body }) => isBudgetFinalization(body), answer)
        yield* llm.pushMatch(({ body }) => !isBudgetFinalization(body), reply().hang())

        const result = yield* opencode.run("Give the best supported answer.", {
          format: "json",
          extraArgs: ["--time-budget", "2", "--output", outputPath],
          bunRun: true,
          env: { ALTIMATE_CLI_YOLO: "true" },
        })
        // altimate_change start — finalization also recovers an abort during a silent-turn followup
        opencode.expectExit(result, 0)
        // altimate_change end
        expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(answer)
        const requests = workRequests(yield* llm.inputs)
        expect(JSON.stringify(requests[1])).toContain(SessionTermination.replyAfterSilentTurn())
        expect(requests.filter(isBudgetFinalization)).toHaveLength(1)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "budget_exhausted")).toMatchObject([{ limit_seconds: 2 }])
        expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(2)
        expect(events.filter((event) => event.type === "silent_turn")).toHaveLength(0)
        expect(events.filter((event) => event.type === "termination")).toMatchObject([
          { why_harness_stopped: "budget-exhausted", time_budget_s: 2, time_budget_deadline: "hard" },
        ])
      }),
    90_000,
  )

  cliIt.live(
    "a fast --time-budget run overrides the environment and fires neither deadline",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const answer = "The answer is ready."
        const outputPath = path.join(home, "answer.md")
        yield* llm.text(answer)
        const result = yield* opencode.run("Answer directly.", {
          format: "json",
          extraArgs: ["--time-budget", "4", "--output", outputPath],
          bunRun: true,
          env: {
            ALTIMATE_RUN_TIME_BUDGET_S: "not-a-number",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              tracing: { enabled: true, dir: path.join(home, "traces"), maxFiles: 0 },
            }),
          },
        })
        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(answer)
        const requests = workRequests(yield* llm.inputs)
        expect(requests).toHaveLength(1)
        expect(JSON.stringify(requests)).not.toContain(SessionTermination.REPLY_BEFORE_TIME_BUDGET)
        expect(requests.filter(isBudgetFinalization)).toHaveLength(0)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "time_budget_warning")).toHaveLength(0)
        expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(0)
        expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(0)
        expect(events.filter((event) => event.type === "termination")).toMatchObject([
          { why_harness_stopped: "none", time_budget_s: 4, time_budget_deadline: "none" },
        ])
        const saved = events.filter((event) => event.type === "trace_saved")
        expect(saved).toHaveLength(1)
        const trace: TraceFile = yield* Effect.promise(() => Bun.file(saved[0]!.path as string).json())
        expect(trace.metadata).toMatchObject({ time_budget_s: 4, time_budget_deadline: "none" })
        expect(trace.metadata.elapsed_s).toBeGreaterThanOrEqual(0)
        expect(trace.metadata.elapsed_s).toBeLessThan(3.2)
      }),
    90_000,
  )

  for (const invalid of [
    { name: "zero CLI value", extraArgs: ["--time-budget", "0"], env: { ALTIMATE_RUN_TIME_BUDGET_S: "5" } },
    { name: "negative CLI value", extraArgs: ["--time-budget=-2"], env: { ALTIMATE_RUN_TIME_BUDGET_S: "5" } },
    { name: "nonnumeric CLI value", extraArgs: ["--time-budget", "invalid"], env: { ALTIMATE_RUN_TIME_BUDGET_S: "5" } },
    { name: "nonnumeric environment value", extraArgs: [], env: { ALTIMATE_RUN_TIME_BUDGET_S: "invalid" } },
  ]) {
    cliIt.live(
      `--time-budget rejects ${invalid.name} before making a model request`,
      ({ llm, home, opencode }) =>
        Effect.gen(function* () {
          const outputPath = path.join(home, "answer.md")
          const result = yield* opencode.run("This must not run.", {
            format: "json",
            extraArgs: [...invalid.extraArgs, "--output", outputPath],
            env: invalid.env,
            bunRun: true,
          })
          opencode.expectExit(result, 1)
          expect(result.stderr).toContain("--time-budget must be a positive number")
          expect(yield* llm.calls).toBe(0)
          expect(yield* Effect.promise(() => Bun.file(outputPath).exists())).toBe(false)
        }),
      90_000,
    )
  }
})
