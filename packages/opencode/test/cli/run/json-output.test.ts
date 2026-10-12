import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import path from "node:path"
import type { TraceFile } from "../../../src/altimate/observability/tracing"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

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
          // --output accumulates completed text, including tool preambles, and
          // writes once at normal termination. It is not a crash-durable stream.
          expect(yield* Effect.promise(() => Bun.file(outputPath).exists())).toBe(false)
        } finally {
          releaseAnswer()
        }
        const result = yield* Fiber.join(running)
        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(`${preamble}\n\n${answer}`)

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
})
