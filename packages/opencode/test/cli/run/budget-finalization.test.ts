import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import fs from "node:fs/promises"
import path from "node:path"
import { RunAccounting } from "@/cli/cmd/run-accounting"
import { SessionTermination } from "@/session/termination"
import { cliIt } from "../../lib/cli-process"
import { raw, reply } from "../../lib/llm-server"
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
  // altimate_change start — a failed answer_commit retry revokes the prior echo turn allowance
  test("a successful answer_commit grants the committed echo exemption", () => {
    const accounting = RunAccounting.create()
    expect(accounting.committedAnswer).toBe(false)
    accounting.onAnswerCommit("completed")
    expect(accounting.committedAnswer).toBe(true)
    accounting.resetCommittedAnswer()
    expect(accounting.committedAnswer).toBe(false)
  })

  test("a failed answer_commit retry clears the committed echo exemption", () => {
    const accounting = RunAccounting.create()
    accounting.onAnswerCommit("completed")
    expect(accounting.committedAnswer).toBe(true)
    accounting.onAnswerCommit("error")
    expect(accounting.committedAnswer).toBe(false)
  })
  // altimate_change end
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
  // altimate_change start — attached turn limits use persisted request events without session fetches
  for (const scenario of ["ordinary", "shared-request", "failed-commit-retry"] as const) {
    const sharedRequest = scenario === "shared-request"
    const failedRetry = scenario === "failed-commit-retry"
    cliIt.concurrent(
      sharedRequest
        ? "a new persisted request on --attach --session clears the committed echo exemption"
        : failedRetry
          ? "a successful answer_commit followed by a failed retry revokes the committed echo exemption"
          : "an ordinary over-budget step requests abort without awaiting any session fetch",
      ({ opencode }) =>
        Effect.gen(function* () {
          const sessionID = "ses_budget_attached"
          let stream: ReadableStreamDefaultController<Uint8Array>
          let aborts = 0
          let sessionFetches = 0
          let prompts = 0
          let subscriptionReady = Promise.withResolvers<void>()
          let finishPrompt: (value: Response) => void = () => {}
          const encoder = new TextEncoder()
          const publish = (type: string, properties: object) =>
            stream.enqueue(encoder.encode(`data: ${JSON.stringify({ type, properties })}\n\n`))
          const assistant = (messageID: string, parentID: string) => ({
            id: messageID,
            sessionID,
            role: "assistant",
            parentID,
            agent: "build",
            modelID: "test-model",
            providerID: "test",
            time: { created: Date.now() },
          })
          const start = (messageID: string, parentID: string) => {
            publish("message.updated", { info: assistant(messageID, parentID) })
            publish("message.part.updated", {
              part: { id: `${messageID}_start`, messageID, sessionID, type: "step-start" },
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
                      {
                        headers: { "content-type": "text/event-stream" },
                      },
                    )
                  if (route === `/session/${sessionID}` && request.method === "GET") {
                    sessionFetches++
                    // This never settles: a read on the step-start path would prevent the abort.
                    return new Promise<Response>(() => {})
                  }
                  if (route === `/session/${sessionID}/abort`) {
                    aborts++
                    const error = { name: "MessageAbortedError", data: { message: "aborted by turn limit" } }
                    publish("session.error", { sessionID, error })
                    publish("session.status", { sessionID, status: { type: "idle" } })
                    finishPrompt(Response.json({ info: { error } }))
                    return Response.json(true)
                  }
                  if (route === `/session/${sessionID}/message` && request.method === "POST") {
                    const body = (await request.json()) as { messageID: string }
                    // The SDK connects SSE lazily, including during finalization.
                    // Wait for this prompt's subscriber before publishing its events.
                    const ready = subscriptionReady
                    await ready.promise
                    subscriptionReady = Promise.withResolvers<void>()
                    const parentID = body.messageID
                    const messageID = `${parentID}zz_assistant`
                    prompts++
                    publish("session.status", { sessionID, status: { type: "busy" } })
                    start(messageID, parentID)
                    if (prompts > 1) {
                      publish("message.part.updated", {
                        part: {
                          id: `${messageID}_text`,
                          messageID,
                          sessionID,
                          type: "text",
                          text: "Budget finalization completed.",
                          time: { start: 1, end: 2 },
                        },
                      })
                      publish("message.part.updated", {
                        part: {
                          id: `${messageID}_finish`,
                          messageID,
                          sessionID,
                          type: "step-finish",
                          reason: "stop",
                        },
                      })
                      publish("session.status", { sessionID, status: { type: "idle" } })
                      return Response.json({ info: { finish: "stop" } })
                    }
                    if (sharedRequest || failedRetry) {
                      publish("message.part.updated", {
                        part: {
                          id: `${messageID}_commit`,
                          messageID,
                          sessionID,
                          type: "tool",
                          tool: "answer_commit",
                          state: {
                            status: "completed",
                            input: {},
                            output: "Original committed answer.",
                            title: "Committed",
                          },
                        },
                      })
                    }
                    if (failedRetry) {
                      publish("message.part.updated", {
                        part: {
                          id: `${messageID}_commit_retry`,
                          messageID,
                          sessionID,
                          type: "tool",
                          tool: "answer_commit",
                          state: { status: "error", input: {}, error: "The retry failed validation." },
                        },
                      })
                    }
                    if (sharedRequest) {
                      // The original echo remains exempt, including synthetic compaction continuation rows.
                      const continuationID = `${parentID}_continuation`
                      publish("message.updated", { info: { id: continuationID, sessionID, role: "user" } })
                      publish("message.part.updated", {
                        part: {
                          id: `${continuationID}_text`,
                          messageID: continuationID,
                          sessionID,
                          type: "text",
                          synthetic: true,
                          text: "Continue the compacted request.",
                        },
                      })
                      start(`${parentID}_echo`, continuationID)
                      const nextRequestID = "msg_000_shared_request"
                      publish("message.updated", { info: { id: nextRequestID, sessionID, role: "user" } })
                      publish("message.part.updated", {
                        part: {
                          id: `${nextRequestID}_text`,
                          messageID: nextRequestID,
                          sessionID,
                          type: "text",
                          text: "A new user request.",
                        },
                      })
                      // The request boundary is emitted after the real user and its parts are persisted.
                      publish("session.request.started", { sessionID, messageID: nextRequestID })
                      // A delayed update from the old request must not re-arm its exemption.
                      // Client-supplied user IDs need not sort after every earlier assistant ID.
                      publish("message.updated", { info: assistant(messageID, parentID) })
                      publish("message.part.updated", {
                        part: {
                          id: `${messageID}_commit`,
                          messageID,
                          sessionID,
                          type: "tool",
                          tool: "answer_commit",
                          state: {
                            status: "completed",
                            input: {},
                            output: "Stale committed answer.",
                            title: "Committed",
                          },
                        },
                      })
                      // Its parent predates this subscription, so even the first observed
                      // update of this older assistant cannot belong to the new request.
                      const unseenAssistantID = `${parentID}zzz_unseen_assistant`
                      publish("message.updated", { info: assistant(unseenAssistantID, "msg_older_unobserved_parent") })
                      publish("message.part.updated", {
                        part: {
                          id: `${unseenAssistantID}_commit`,
                          messageID: unseenAssistantID,
                          sessionID,
                          type: "tool",
                          tool: "answer_commit",
                          state: {
                            status: "completed",
                            input: {},
                            output: "An earlier unobserved request committed.",
                            title: "Committed",
                          },
                        },
                      })
                      start(`${nextRequestID}_assistant`, nextRequestID)
                    } else {
                      start(`${parentID}_second`, parentID)
                    }
                    return new Promise<Response>((resolve) => {
                      finishPrompt = resolve
                    })
                  }
                  return Response.json({ error: `Unexpected route: ${request.method} ${route}` }, { status: 404 })
                },
              }),
            ),
            (server) => Effect.sync(() => server.stop(true)),
          )
          const result = yield* opencode.run("Start the work.", {
            format: "json",
            extraArgs: ["--attach", server.url.toString(), "--session", sessionID, "--max-turns", "1", "--no-trace"],
            timeoutMs: 20_000,
            bunRun: true,
          })
          opencode.expectExit(result, 1)
          expect(aborts).toBe(1)
          expect(sessionFetches).toBe(0)
          expect(prompts).toBe(2)
          const events = opencode.parseJsonEvents(result.stdout)
          if (failedRetry) {
            expect(events.filter((event) => event.type === "tool_use").map((event) => event.part)).toEqual([
              expect.objectContaining({ tool: "answer_commit", state: expect.objectContaining({ status: "completed" }) }),
              expect.objectContaining({ tool: "answer_commit", state: expect.objectContaining({ status: "error" }) }),
            ])
          }
          const budgetIndex = events.findIndex((event) => event.type === "budget_exhausted")
          expect(budgetIndex).toBeGreaterThan(-1)
          expect(events.slice(0, budgetIndex).filter((event) => event.type === "step_start")).toHaveLength(
            sharedRequest ? 2 : 1,
          )
          expect(
            events.filter((event) => event.type === "text").map((event) => (event.part as { text: string }).text),
          ).toEqual(["Budget finalization completed."])
        }),
      30_000,
    )
  }
  // altimate_change end
  // altimate_change start — a completed answer gets one tool-free echo beyond the work-turn limit
  cliIt.concurrent(
    "a request queued before the committed echo step-start preserves its output and is refused for the exhausted budget",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const committed = "Committed revenue before the queued request: 42"
        const echoDispatched = Promise.withResolvers<void>()
        const releaseEcho = Promise.withResolvers<void>()
        let generations = 0
        const provider = yield* Effect.acquireRelease(
          Effect.sync(() => Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            idleTimeout: 0,
            async fetch(request) {
              const body = await request.text()
              if (!body.includes("Generate a title for this conversation") && ++generations === 2) {
                // Hold even the response headers: the provider cannot emit step-start yet.
                echoDispatched.resolve()
                await releaseEcho.promise
              }
              return fetch(`${llm.url}/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
                signal: request.signal,
              })
            },
          })),
          (server) => Effect.sync(() => {
            releaseEcho.resolve()
            server.stop(true)
          }),
        )
        yield* llm.tool("answer_commit", {
          fields: [{ name: "", value: committed }],
          answer_only: true,
          basis: "Summed orders.amount over all orders at order grain.",
        })
        yield* llm.text("The provider echo must be replaced by the stored commit.")
        yield* llm.pushMatch(({ body }) => !isFinalization(body), reply().reason("The queued request must be refused.").hang())
        yield* llm.textMatch(({ body }) => isFinalization(body), "No budget remains for the queued request.")
        const server = yield* opencode.serve({
          env: {
            ALTIMATE_ANSWER_COMMIT: "1",
            // An attached run cannot resolve --agent locally, so the server defaults to the analyst.
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...testProviderConfig(`${provider.url}v1`), default_agent: "analyst" }),
          },
          bunRun: true,
        })
        const sdk = createOpencodeClient({ baseUrl: server.url, throwOnError: true })
        const session = yield* Effect.promise(() => sdk.session.create({ title: "Queued echo budget" }))
        const sessionID = session.data!.id
        const run = yield* opencode.run("Commit the revenue answer.", {
          format: "json",
          extraArgs: ["--attach", server.url, "--session", sessionID, "--max-turns", "1", "--no-trace"],
          env: { ALTIMATE_ANSWER_COMMIT: "1" },
          timeoutMs: 60_000,
          bunRun: true,
        }).pipe(Effect.forkChild)
        yield* Effect.promise(() => echoDispatched.promise).pipe(Effect.timeout("30 seconds"))
        // noReply persists the foreign request and publishes its boundary; the running loop will pick it up.
        const queued = yield* Effect.promise(() => sdk.session.prompt({
          sessionID,
          agent: "analyst",
          model: { providerID: "test", modelID: "test-model" },
          noReply: true,
          parts: [{ type: "text", text: "Now answer a different question." }],
        }))
        releaseEcho.resolve()
        const result = yield* Fiber.join(run)
        opencode.expectExit(result, 1)
        const events = opencode.parseJsonEvents(result.stdout)
        const budgetIndex = events.findIndex((event) => event.type === "budget_exhausted")
        expect(budgetIndex).toBeGreaterThan(-1)
        const beforeBudget = events.slice(0, budgetIndex)
        expect(beforeBudget.filter((event) => event.type === "step_start")).toHaveLength(2)
        expect(beforeBudget.filter((event) => event.type === "text").map((event) => (event.part as { text: string }).text))
          .toEqual([committed])
        expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(1)
        const messages = yield* Effect.promise(() => sdk.session.messages({ sessionID }))
        const echo = messages.data!.find((message) => message.parts.some((part) => part.type === "text" && part.text === committed))!
        expect(echo.info).toMatchObject({ role: "assistant", finish: "stop" })
        expect(echo.info).not.toHaveProperty("parentID", queued.data!.info.id)
        expect(messages.data!.map((message) => message.info)).toContainEqual(expect.objectContaining({
          role: "assistant",
          parentID: queued.data!.info.id,
          error: expect.objectContaining({ name: "MessageAbortedError" }),
        }))
      }),
    90_000,
  )
  // altimate_change start — compaction continuations keep their originating request's echo allowance
  // These exercise the same ownership helper as run.ts without requiring a listening socket.
  for (const queued of ["none", "before the marker", "during the summary"] as const) {
    test(`proactive compaction preserves committed echo ownership with a queued request: ${queued}`, () => {
      const ownership = RunAccounting.createRequestOwnership()
      const accounting = RunAccounting.create()
      const committedRequests = new Set<string>()
      ownership.beginRequest("original")
      ownership.onAssistantMessage({ id: "commit", parentID: "original" })
      accounting.onStepStart("commit")
      committedRequests.add(ownership.ownerOf("commit")!)
      const queue = () => {
        ownership.onUserMessage("queued")
        ownership.beginRequest("queued")
      }
      if (queued === "before the marker") queue()
      ownership.onUserMessage("marker")
      ownership.onUserMessage("marker", "original")
      ownership.onAssistantMessage({ id: "summary", parentID: "marker" })
      accounting.onAssistantMessage({ id: "summary", summary: true })
      expect(accounting.onStepStart("summary")).toBe(false)
      if (queued === "during the summary") queue()

      // SessionCompaction persists this synthetic user before reporting its origin.
      ownership.onUserMessage("continuation")
      ownership.onUserMessage("continuation", "marker")
      // Another compaction must preserve the original ID, not the intervening user ID.
      ownership.onUserMessage("second-marker", "continuation")
      ownership.onUserMessage("second-continuation", "second-marker")
      ownership.onAssistantMessage({ id: "echo", parentID: "second-continuation" })
      expect(ownership.ownerOf("echo")).toBe("original")
      expect(accounting.onStepStart("echo")).toBe(true)
      expect(accounting.turnCount).toBe(2)
      expect(committedRequests.has(ownership.ownerOf("echo")!)).toBe(true)

      if (queued !== "none") {
        ownership.onAssistantMessage({ id: "queued-work", parentID: "queued" })
        // Late updates from the old request cannot transfer its exemption to the new one.
        ownership.onAssistantMessage({ id: "commit", parentID: "original" })
        expect(ownership.ownerOf("queued-work")).toBe("queued")
        expect(committedRequests.has(ownership.ownerOf("queued-work")!)).toBe(false)
      }
    })
  }

  test("an ordinary request compacted after a committed echo keeps its own over-budget ownership", () => {
    const ownership = RunAccounting.createRequestOwnership()
    ownership.beginRequest("committed")
    ownership.onAssistantMessage({ id: "old-echo", parentID: "committed" })
    ownership.onUserMessage("ordinary")
    ownership.beginRequest("ordinary")
    ownership.onUserMessage("ordinary", "committed")
    // The new request can compact before creating its first assistant.
    ownership.onUserMessage("marker", "ordinary")
    ownership.onUserMessage("continuation", "marker")
    ownership.onAssistantMessage({ id: "ordinary-work", parentID: "continuation" })
    expect(ownership.ownerOf("ordinary-work")).toBe("ordinary")
    expect(ownership.ownerOf("ordinary-work")).not.toBe(ownership.ownerOf("old-echo"))
    // A continuation with an unobserved parent cannot borrow the active request.
    ownership.onUserMessage("unknown", "unobserved")
    ownership.onAssistantMessage({ id: "unknown-work", parentID: "unknown" })
    expect(ownership.ownerOf("unknown-work")).toBeUndefined()
  })
  // altimate_change end
  cliIt.concurrent(
    "answer_commit on --max-turns 1 publishes the committed output on its extra echo turn",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const committed = "Committed revenue: 42"
        yield* llm.tool("answer_commit", {
          fields: [{ name: "", value: committed }],
          answer_only: true,
          basis: "Summed orders.amount over all orders at order grain.",
        })
        yield* llm.text("A different provider echo must be replaced.")
        // The old budget check aborts the echo and requests this fallback instead.
        yield* llm.textMatch(({ body }) => isFinalization(body), "The echo was aborted by the turn limit.")

        const result = yield* opencode.run("Commit the revenue answer.", {
          agent: "analyst",
          format: "json",
          extraArgs: ["--max-turns", "1"],
          env: { ALTIMATE_ANSWER_COMMIT: "1" },
          timeoutMs: 60_000,
          bunRun: true,
        })
        opencode.expectExit(result, 0)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(0)
        expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(0)
        expect(events.filter((event) => event.type === "step_start")).toHaveLength(2)
        expect(events.filter((event) => event.type === "tool_use").map((event) => event.part)).toContainEqual(
          expect.objectContaining({ tool: "answer_commit", state: expect.objectContaining({ status: "completed" }) }),
        )
        expect(events.filter((event) => event.type === "text").map((event) => (event.part as { text: string }).text)).toEqual([
          committed,
        ])
        expect(events.filter((event) => event.type === "termination")).toMatchObject([
          { why_model_stopped: "stop", why_harness_stopped: "none" },
        ])
        const requests = (yield* llm.inputs).filter(
          (body) => !JSON.stringify(body).includes("Generate a title for this conversation"),
        )
        expect(requests).toHaveLength(2)
        expect(requests[1]!.tools ?? []).toEqual([])
        expect(requests.filter(isFinalization)).toHaveLength(0)
      }),
    90_000,
  )
  cliIt.concurrent(
    "answer_commit on --max-turns 1 publishes the committed output after an echo context overflow",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const committed = "Committed revenue after overflow: 42"
        yield* llm.tool("answer_commit", {
          fields: [{ name: "", value: committed }],
          answer_only: true,
          basis: "Summed orders.amount over all orders at order grain.",
        })
        // A streaming overflow begins the echo step, whose committed text can finish the request.
        // The compatible provider exposes the error's message to the processor.
        yield* llm.push({
          type: "sse",
          head: [],
          tail: [{ error: { message: JSON.stringify({ type: "error", error: { code: "context_length_exceeded" } }) } }],
        })

        const result = yield* opencode.run("Commit the revenue answer.", {
          agent: "analyst",
          format: "json",
          extraArgs: ["--max-turns", "1"],
          env: { ALTIMATE_ANSWER_COMMIT: "1" },
          timeoutMs: 60_000,
          bunRun: true,
        })
        opencode.expectExit(result, 0)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(0)
        expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(0)
        expect(events.filter((event) => event.type === "error")).toHaveLength(0)
        expect(events.filter((event) => event.type === "step_start")).toHaveLength(2)
        const texts = events
          .filter((event) => event.type === "text")
          .map((event) => (event.part as { text: string }).text)
        expect(texts).toEqual([committed])
        expect(events.filter((event) => event.type === "termination")).toMatchObject([
          // The echo overflowed, so the model never produced a stop; the harness delivered the committed text.
          { why_model_stopped: "tool-call", why_harness_stopped: "none" },
        ])
        const requests = (yield* llm.inputs).filter(
          (body) => !JSON.stringify(body).includes("Generate a title for this conversation"),
        )
        expect(requests).toHaveLength(2)
        expect(requests[1]!.tools ?? []).toEqual([])
        expect(requests.filter(isFinalization)).toHaveLength(0)
      }),
    90_000,
  )
  cliIt.concurrent(
    "a soft-time reminder clears the committed answer turn exemption for its new request",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.tool("answer_commit", {
          fields: [{ name: "", value: "The original committed answer." }],
          answer_only: true,
          basis: "Summed orders.amount over all orders at order grain.",
        })
        yield* llm.push(reply().reason("Waiting to publish the committed echo.").hang())
        yield* llm.textMatch(({ body }) => isFinalization(body), "The new request exhausted its turn budget.")
        yield* llm.pushMatch(({ body }) => !isFinalization(body), reply().reason("Working on the new request.").hang())

        const result = yield* opencode.run("Commit the revenue answer.", {
          agent: "analyst",
          format: "json",
          extraArgs: ["--max-turns", "1", "--time-budget", "10"],
          env: { ALTIMATE_ANSWER_COMMIT: "1" },
          timeoutMs: 60_000,
          bunRun: true,
        })
        opencode.expectExit(result, 1)
        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.filter((event) => event.type === "time_budget_warning")).toHaveLength(1)
        expect(events.filter((event) => event.type === "budget_exhausted")).toMatchObject([{ limit: 1 }])
        const budgetIndex = events.findIndex((event) => event.type === "budget_exhausted")
        expect(events.slice(0, budgetIndex).filter((event) => event.type === "step_start")).toHaveLength(2)
        // The commit belongs to the first request and is delivered before the reminder request is answered.
        expect(events.filter((event) => event.type === "text").map((event) => (event.part as { text: string }).text)).toEqual([
          "The original committed answer.",
          "The new request exhausted its turn budget.",
        ])
        expect((yield* llm.inputs).filter(isFinalization)).toHaveLength(1)
      }),
    90_000,
  )
  // altimate_change end
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
        // altimate_change start — a non-commit still stops before the second work step is emitted
        const budgetIndex = events.findIndex((event) => event.type === "budget_exhausted")
        expect(events[budgetIndex]).toMatchObject({ limit: 1 })
        expect(events.slice(0, budgetIndex).filter((event) => event.type === "step_start")).toHaveLength(1)
        // altimate_change end
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
cliIt.live(
  "a soft-interrupted partial answer gets one finalization when the reminder stalls before step-start",
  ({ llm, opencode, home }) =>
    Effect.gen(function* () {
      const outputPath = path.join(home, "answer.md")
      const finalAnswer = "The available evidence supports this final answer."
      const partialAnswer = "Let me examine the evidence before"
      yield* llm.push(reply().text(partialAnswer).hang())
      yield* llm.textMatch(({ body }) => isFinalization(body), finalAnswer)
      // No SSE chunks means the reminder's provider request never starts a new step.
      yield* llm.pushMatch(({ body }) => !isFinalization(body), raw({ hang: true }))
      const result = yield* opencode.run("Give the best supported answer.", {
        format: "json",
        extraArgs: ["--time-budget", "5", "--output", outputPath],
        bunRun: true,
        timeoutMs: 30_000,
      })
      const requests = (yield* llm.inputs).filter(
        (body) => !JSON.stringify(body).includes("Generate a title for this conversation"),
      )
      expect(requests).toHaveLength(3)
      expect(JSON.stringify(requests[1])).toContain(SessionTermination.REPLY_BEFORE_TIME_BUDGET)
      expect(requests.filter(isFinalization)).toHaveLength(1)
      opencode.expectExit(result, 0)
      expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(finalAnswer)
      const events = opencode.parseJsonEvents(result.stdout)
      const hardDeadline = events.findIndex((event) => event.type === "budget_exhausted")
      expect(hardDeadline).toBeGreaterThanOrEqual(0)
      expect(events.slice(0, hardDeadline).filter((event) => event.type === "step_start")).toHaveLength(1)
      expect(events.slice(0, hardDeadline).filter((event) => event.type === "text")).toMatchObject([
        { part: { text: partialAnswer } },
      ])
      expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(1)
      expect(events.filter((event) => event.type === "text").at(-1)).toMatchObject({
        part: { text: finalAnswer },
      })
      expect(events.filter((event) => event.type === "termination")).toMatchObject([
        { why_harness_stopped: "budget-exhausted", time_budget_deadline: "hard" },
      ])
      expect(yield* llm.pending).toBe(0)
    }),
  60_000,
)

cliIt.live(
  "a complete answer before the time deadline skips budget finalization",
  ({ llm, opencode, home }) =>
    Effect.gen(function* () {
      const outputPath = path.join(home, "answer.md")
      const answer = "The complete answer is ready."
      yield* llm.text(answer)
      const result = yield* opencode.run("Answer directly.", {
        format: "json",
        extraArgs: ["--time-budget", "5", "--output", outputPath],
        bunRun: true,
        timeoutMs: 30_000,
      })
      opencode.expectExit(result, 0)
      expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(answer)
      const requests = (yield* llm.inputs).filter(
        (body) => !JSON.stringify(body).includes("Generate a title for this conversation"),
      )
      expect(requests).toHaveLength(1)
      expect(requests.filter(isFinalization)).toHaveLength(0)
      const events = opencode.parseJsonEvents(result.stdout)
      expect(events.filter((event) => event.type === "budget_exhausted")).toHaveLength(0)
      expect(events.filter((event) => event.type === "silent_turn_reply")).toHaveLength(0)
    }),
  60_000,
)

for (const finalAnswer of ["The available evidence supports this limited answer.", ""]) {
  cliIt.live(
    `hard time-budget finalization uses low effort and exits ${finalAnswer ? "0 with an answer" : "nonzero without an answer"}`,
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const outputPath = path.join(home, "answer.md")
        const config = testProviderConfig(llm.url)
        const model = config.provider.test.models["test-model"]
        const partialAnswer = "The first group contains 12 records; the rest remain unverified."
        yield* llm.push(reply().text(partialAnswer).reason("Still considering the evidence.").hang())
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
          expect(output).toContain("Partial assistant response (not finalized):")
          expect(output).toContain(partialAnswer)
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
