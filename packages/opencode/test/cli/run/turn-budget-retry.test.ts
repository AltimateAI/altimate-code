// altimate_change start — `--max-turns` charges completed steps, not retried attempts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionRetry } from "../../../src/session/retry"
import { cliIt } from "../../lib/cli-process"
import { raw } from "../../lib/llm-server"

const chunk = (delta: Record<string, unknown>) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta }],
})

// A provider stream that starts a step, streams some text, then reports an error
// in-band. The error matches the processor's retryable rate-limit detection, so
// the session retries the step.
const failsMidStream = () =>
  raw({
    head: [
      chunk({ role: "assistant" }),
      chunk({ content: "Partial work" }),
      { error: { message: "rate limit exceeded", type: "rate_limit_error", code: "rate_limit_exceeded" } },
    ],
  })

describe("opencode run: --max-turns charges completed steps only", () => {
  cliIt.concurrent(
    "a step that fails mid-stream and is retried costs one turn",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(failsMidStream())
        yield* llm.text("The answer after one retry.")
        const result = yield* opencode.run("Answer once.", {
          format: "json",
          extraArgs: ["--max-turns", "1", "--no-trace"],
          timeoutMs: 45_000,
          bunRun: true,
        })
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(0)
        expect(events.filter((event) => event.type === "error")).toHaveLength(0)
        expect(
          events.filter((event) => event.type === "text").map((event) => (event.part as { text: string }).text),
        ).toEqual(["The answer after one retry."])
        // One step-finish for the one completed step, whatever the number of attempts.
        expect(events.filter((event) => event.type === "step_finish")).toHaveLength(1)
        opencode.expectExit(result, 0)
      }),
    60_000,
  )
  // Attached-session fake: the CLI sees exactly the events the session publishes for
  // a step whose attempts start and fail, without waiting out real retry backoff.
  const attached = (behavior: "all-attempts-fail" | "endless-attempts" | "compaction-after-budget") =>
    Effect.gen(function* () {
      const sessionID = "ses_turn_budget_retry"
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined
      let subscriptionReady = Promise.withResolvers<void>()
      let finishPrompt: (value: Response) => void = () => {}
      let attemptTimer: ReturnType<typeof setInterval> | undefined
      const counts = { prompts: 0, aborts: 0, attempts: 0 }
      const encoder = new TextEncoder()
      const publish = (type: string, properties: object) =>
        stream?.enqueue(encoder.encode(`data: ${JSON.stringify({ type, properties })}\n\n`))
      const startAttempt = (messageID: string) => {
        counts.attempts++
        publish("message.part.updated", {
          part: { id: `${messageID}_start_${counts.attempts}`, messageID, sessionID, type: "step-start" },
        })
        publish("session.status", {
          sessionID,
          status: { type: "retry", attempt: counts.attempts, message: "rate limit exceeded", next: Date.now() + 10 },
        })
      }
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            idleTimeout: 0,
            async fetch(request) {
              const route = new URL(request.url).pathname
              if (route === "/provider")
                return Response.json({ all: [{ id: "test", models: { "test-model": {} } }], connected: ["test"] })
              if (route === "/config") return Response.json({ share: "disabled", tracing: { enabled: false } })
              if (route === "/event")
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      stream = controller
                      subscriptionReady.resolve()
                      publish("server.connected", {})
                    },
                  }),
                  { headers: { "content-type": "text/event-stream" } },
                )
              if (route === `/session/${sessionID}/abort`) {
                counts.aborts++
                clearInterval(attemptTimer)
                const error = { name: "MessageAbortedError", data: { message: "aborted" } }
                publish("session.error", { sessionID, error })
                publish("session.status", { sessionID, status: { type: "idle" } })
                finishPrompt(Response.json({ info: { error } }))
                return Response.json(true)
              }
              if (route === `/session/${sessionID}/message` && request.method === "POST") {
                const body = (await request.json()) as { messageID: string; noReply?: boolean }
                // The soft time-budget reminder is saved without a reply; it is not a prompt.
                if (body.noReply) return Response.json({ info: { id: body.messageID, role: "user" } })
                const ready = subscriptionReady
                await ready.promise
                subscriptionReady = Promise.withResolvers<void>()
                counts.prompts++
                const parentID = body.messageID
                const messageID = `${parentID}zz_assistant_${counts.prompts}`
                publish("session.status", { sessionID, status: { type: "busy" } })
                publish("message.updated", {
                  info: {
                    id: messageID,
                    sessionID,
                    role: "assistant",
                    parentID,
                    agent: "build",
                    modelID: "test-model",
                    providerID: "test",
                    time: { created: Date.now() },
                  },
                })
                if (counts.prompts > 1) {
                  // The time-budget finalization reply completes normally.
                  startAttempt(messageID)
                  publish("message.part.updated", {
                    part: {
                      id: `${messageID}_text`,
                      messageID,
                      sessionID,
                      type: "text",
                      text: "Best-effort answer.",
                      time: { start: 1, end: 2 },
                    },
                  })
                  publish("message.part.updated", {
                    part: { id: `${messageID}_finish`, messageID, sessionID, type: "step-finish", reason: "stop" },
                  })
                  publish("session.status", { sessionID, status: { type: "idle" } })
                  return Response.json({ info: { finish: "stop" } })
                }
                if (behavior === "compaction-after-budget") {
                  // The work step answers and completes, using the whole one-turn budget.
                  startAttempt(messageID)
                  publish("message.part.updated", {
                    part: {
                      id: `${messageID}_text`,
                      messageID,
                      sessionID,
                      type: "text",
                      text: "The answer.",
                      time: { start: 1, end: 2 },
                    },
                  })
                  publish("message.part.updated", {
                    part: { id: `${messageID}_finish`, messageID, sessionID, type: "step-finish", reason: "stop" },
                  })
                  // Compaction machinery then runs a step of its own; it is never charged or stopped.
                  const summaryID = `${messageID}zz_summary`
                  publish("message.updated", {
                    info: {
                      id: summaryID,
                      sessionID,
                      role: "assistant",
                      parentID,
                      agent: "compaction",
                      summary: true,
                      modelID: "test-model",
                      providerID: "test",
                      time: { created: Date.now() },
                    },
                  })
                  publish("message.part.updated", {
                    part: { id: `${summaryID}_start`, messageID: summaryID, sessionID, type: "step-start" },
                  })
                  publish("message.part.updated", {
                    part: { id: `${summaryID}_finish`, messageID: summaryID, sessionID, type: "step-finish", reason: "stop" },
                  })
                  publish("session.status", { sessionID, status: { type: "idle" } })
                  return Response.json({ info: { finish: "stop" } })
                }
                if (behavior === "all-attempts-fail") {
                  // The first attempt plus every retry the processor allows, none completing.
                  for (let attempt = 0; attempt <= SessionRetry.RETRY_MAX_ATTEMPTS; attempt++) startAttempt(messageID)
                  const error = { name: "APIError", data: { message: "rate limit exceeded", isRetryable: true } }
                  publish("session.error", { sessionID, error })
                  publish("session.status", { sessionID, status: { type: "idle" } })
                  return Response.json({ info: { error } })
                }
                // A step that keeps failing and restarting without ever completing:
                // more attempts than one step's retry cap at once, then more until aborted.
                for (let attempt = 0; attempt <= SessionRetry.RETRY_MAX_ATTEMPTS + 1; attempt++) startAttempt(messageID)
                attemptTimer = setInterval(() => startAttempt(messageID), 20)
                return new Promise<Response>((resolve) => {
                  finishPrompt = resolve
                })
              }
              return Response.json({ error: `Unexpected route: ${request.method} ${route}` }, { status: 404 })
            },
          }),
        ),
        (server) =>
          Effect.sync(() => {
            clearInterval(attemptTimer)
            server.stop(true)
          }),
      )
      return { server, sessionID, counts }
    })

  cliIt.concurrent(
    "a step whose every attempt fails costs no turn and surfaces the error",
    ({ opencode }) =>
      Effect.gen(function* () {
        const { server, sessionID, counts } = yield* attached("all-attempts-fail")
        const result = yield* opencode.run("Answer once.", {
          format: "json",
          extraArgs: ["--attach", server.url.toString(), "--session", sessionID, "--max-turns", "1", "--no-trace"],
          timeoutMs: 20_000,
          bunRun: true,
        })
        opencode.expectExit(result, 1)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "step_start")).toHaveLength(SessionRetry.RETRY_MAX_ATTEMPTS + 1)
        // Attempts that never completed did not exhaust the one-turn budget.
        expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(0)
        expect(counts.aborts).toBe(0)
        // The provider failure is what the run reports, and nothing re-prompts after it.
        expect(events.filter((event) => event.type === "error")).toContainEqual(
          expect.objectContaining({ error: expect.objectContaining({ name: "APIError" }) }),
        )
        expect(counts.prompts).toBe(1)
        expect(events.filter((event) => event.type === "termination")).toMatchObject([
          { why_harness_stopped: "error" },
        ])
      }),
    30_000,
  )

  cliIt.concurrent(
    "a compaction step after the budget is used is neither charged nor stopped",
    ({ opencode }) =>
      Effect.gen(function* () {
        const { server, sessionID, counts } = yield* attached("compaction-after-budget")
        const result = yield* opencode.run("Answer once.", {
          format: "json",
          extraArgs: ["--attach", server.url.toString(), "--session", sessionID, "--max-turns", "1", "--no-trace"],
          timeoutMs: 20_000,
          bunRun: true,
        })
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(0)
        expect(counts.aborts).toBe(0)
        expect(counts.prompts).toBe(1)
        opencode.expectExit(result, 0)
      }),
    30_000,
  )

  cliIt.concurrent(
    "attempts that keep restarting without completing are stopped by --max-turns alone",
    ({ opencode }) =>
      Effect.gen(function* () {
        const { server, sessionID, counts } = yield* attached("endless-attempts")
        const result = yield* opencode.run("Answer once.", {
          format: "json",
          extraArgs: ["--attach", server.url.toString(), "--session", sessionID, "--max-turns", "1", "--no-trace"],
          timeoutMs: 20_000,
          bunRun: true,
        })
        opencode.expectExit(result, 1)
        const events = opencode.parseJsonEvents(result.stdout)
        const budgetIndex = events.findIndex((event) => event.type === "budget_exhausted")
        expect(events[budgetIndex]).toMatchObject({ limit: 1 })
        // Exactly one step's worth of attempts ran before the backstop stopped the next.
        expect(events.slice(0, budgetIndex).filter((event) => event.type === "step_start")).toHaveLength(
          SessionRetry.RETRY_MAX_ATTEMPTS + 1,
        )
        expect(counts.aborts).toBe(1)
      }),
    30_000,
  )

  cliIt.concurrent(
    "attempts that keep restarting without completing are still bounded by --time-budget",
    ({ opencode }) =>
      Effect.gen(function* () {
        const { server, sessionID, counts } = yield* attached("endless-attempts")
        const result = yield* opencode.run("Answer once.", {
          format: "json",
          extraArgs: [
            "--attach",
            server.url.toString(),
            "--session",
            sessionID,
            "--time-budget",
            "5",
            "--no-trace",
          ],
          timeoutMs: 25_000,
          bunRun: true,
        })
        const events = opencode.parseJsonEvents(result.stdout)
        // Without a turn budget, the wall-clock budget ends the work.
        expect(events.filter((event) => event.type === "budget_exhausted")).toEqual([
          expect.objectContaining({ limit_seconds: 5 }),
        ])
        expect(counts.aborts).toBeGreaterThanOrEqual(1)
        expect(counts.attempts).toBeGreaterThan(SessionRetry.RETRY_MAX_ATTEMPTS + 1)
        expect(
          events.filter((event) => event.type === "text").map((event) => (event.part as { text: string }).text),
        ).toEqual(["Best-effort answer."])
      }),
    40_000,
  )
})
// altimate_change end
