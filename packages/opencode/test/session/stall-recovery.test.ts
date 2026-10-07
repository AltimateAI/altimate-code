// Drives the REAL session code (SessionProcessor -> LLM.stream -> Provider fetch wrapper -> AI SDK)
// against a local HTTP server that speaks the OpenAI-compatible streaming protocol and, on demand,
// accepts a request and never answers, streams a few chunks and goes silent, or resets the socket.
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Effect, Layer } from "effect"
import net from "net"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import type { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { StallRecovery } from "../../src/session/stall-recovery"
import { SessionRetry } from "../../src/session/retry"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { ProviderError } from "../../src/provider/error"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstanceLegacy } from "./legacy-instance"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)
const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [
      LayerNode.replace(SessionSummary.node, summary),
      LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })),
    ],
  }),
)

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible streaming server
// ---------------------------------------------------------------------------

type Step =
  /** Accept the request and never write a single byte (no headers either). */
  | { kind: "silent" }
  /** Optionally wait, answer with SSE headers, emit `events`, then end / go quiet / reset. */
  | {
      kind: "stream"
      delayMs?: number
      gapMs?: number
      contentType?: string
      events: Array<{ text?: string; tool?: { id: string; name: string; args: string } }>
      end: "stop" | "tool_calls" | "silent" | "reset"
    }

type FakeServer = {
  url: string
  requests: number
  /** Sockets the server saw close (client abort, timeout or our own reset). */
  closed: number
  /** Indexes of requests whose own socket was seen closing. */
  closedRequests: Set<number>
  bodies: any[]
  script: Step[]
  stop: () => void
}

// A raw TCP/HTTP-1.1 server: Bun.serve cannot produce a real mid-body connection reset, and the
// stall shapes below need byte-level control (no headers at all, silent after headers, RST).
function fakeServer(script: Step[]): FakeServer {
  const state: FakeServer = {
    url: "",
    requests: 0,
    closed: 0,
    closedRequests: new Set(),
    bodies: [],
    script,
    stop: () => {},
  }
  const sockets = new Set<net.Socket>()
  const frame = (delta: Record<string, unknown>, finish: string | null = null) => {
    const payload = `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    return `${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n`
  }
  const done = () => {
    const payload = "data: [DONE]\n\n"
    return `${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n0\r\n\r\n`
  }
  const respond = async (sock: net.Socket, step: Step) => {
    if (step.kind === "silent") return // read the request, write nothing, keep the socket open
    if (step.delayMs) await Bun.sleep(step.delayMs)
    if (sock.destroyed) return
    sock.write(
      `HTTP/1.1 200 OK\r\ncontent-type: ${step.contentType ?? "text/event-stream"}\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n`,
    )
    sock.write(frame({ role: "assistant" }))
    for (const ev of step.events) {
      if (step.gapMs) await Bun.sleep(step.gapMs)
      if (sock.destroyed) return
      if (ev.text) sock.write(frame({ content: ev.text }))
      if (ev.tool)
        sock.write(
          frame({
            tool_calls: [
              { index: 0, id: ev.tool.id, type: "function", function: { name: ev.tool.name, arguments: ev.tool.args } },
            ],
          }),
        )
    }
    if (step.end === "stop" || step.end === "tool_calls") {
      sock.write(frame({}, step.end))
      sock.write(done())
      sock.end()
    }
    if (step.end === "reset") {
      await Bun.sleep(150) // let the partial chunks reach the client before the socket dies
      sock.resetAndDestroy()
    }
    // "silent": leave the stream open and write nothing more.
  }
  const server = net.createServer((sock) => {
    sockets.add(sock)
    sock.on("error", () => {})
    let requestIndex = -1
    sock.on("close", () => {
      sockets.delete(sock)
      state.closed++
      if (requestIndex >= 0) state.closedRequests.add(requestIndex)
    })
    let buf = Buffer.alloc(0)
    let handled = false
    sock.on("data", (data) => {
      if (handled) return
      buf = Buffer.concat([buf, data])
      const end = buf.indexOf("\r\n\r\n")
      if (end < 0) return
      const head = buf.subarray(0, end).toString()
      const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0)
      if (buf.length < end + 4 + length) return
      handled = true
      state.bodies.push(JSON.parse(buf.subarray(end + 4, end + 4 + length).toString() || "null"))
      const index = state.requests++
      requestIndex = index
      // Past the end of the script: behave like a healthy provider so a runaway retry loop shows up as a count.
      const step = state.script[index] ?? ({ kind: "stream", events: [{ text: "ok" }], end: "stop" } as Step)
      void respond(sock, step)
    })
  })
  server.listen(0, "127.0.0.1")
  state.url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`
  state.stop = () => {
    for (const s of sockets) s.destroy()
    server.close()
  }
  return state
}

// ---------------------------------------------------------------------------
// Session harness
// ---------------------------------------------------------------------------

const ref = { providerID: "test", modelID: "test-model" }

function providerCfg(url: string, options: Record<string, unknown> = {}) {
  return {
    // Snapshot tracking spawns git in the background; closing the test scope under it surfaces as an
    // "All fibers interrupted" error on the last test, and these tests have no use for snapshots.
    snapshot: false,
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url, ...options },
      },
    },
  }
}

const agent = (): Agent.Info => ({
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
})

type RunOptions = {
  script: Step[]
  /** Provider options (chunkTimeout / headerTimeout): the existing per-provider configuration surface. */
  options?: Record<string, unknown>
  tools?: Record<string, any>
  /** Abort the user signal this long after the request count first reaches 1. */
  cancelAfterMs?: number
  /** Start the cancel countdown once the first request's socket has been torn down (the stall was detected). */
  cancelAfterStall?: boolean
}

const servers: FakeServer[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop()
})

function runSession(opts: RunOptions) {
  const server = fakeServer(opts.script)
  servers.push(server)
  return provideTmpdirInstanceLegacy(
    (dir) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service

        const chat = yield* session.create({})
        const parent = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref as any,
          time: { created: Date.now() },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: parent.id,
          sessionID: chat.id,
          type: "text",
          text: "hi",
        })
        const msg = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: parent.id,
          time: { created: Date.now() },
          finish: "end_turn",
        } as unknown as MessageV2.Assistant
        yield* session.updateMessage(msg as any)
        const mdl = yield* provider.getModel(ProviderID.make(ref.providerID), ModelID.make(ref.modelID))
        const controller = new AbortController()
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
          abort: controller.signal,
        })
        const started = Date.now()
        const timers: Array<ReturnType<typeof setInterval>> = []
        if (opts.cancelAfterMs !== undefined) {
          const poll = setInterval(() => {
            const ready = opts.cancelAfterStall ? server.closedRequests.has(0) : server.requests > 0
            if (!ready) return
            clearInterval(poll)
            timers.push(setTimeout(() => controller.abort(), opts.cancelAfterMs) as any)
          }, 5)
          timers.push(poll)
        }
        const clearTimers = () => {
          for (const t of timers) {
            clearInterval(t)
            clearTimeout(t as any)
          }
        }
        const result = yield* Effect.promise(() =>
          handle.process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: "build",
              model: ref,
            } as unknown as MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "hi" }],
            tools: opts.tools ?? {},
            abort: controller.signal,
          } as LLM.StreamInput),
        ).pipe(Effect.ensuring(Effect.sync(clearTimers)))
        const elapsed = Date.now() - started
        // The server sees a client-side close asynchronously. Every request but the last was torn down by the
        // client (timeout, reset or cancel): wait, bounded, for those close events before anyone asserts on them.
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 2000
          const settled = () =>
            Array.from({ length: Math.max(0, server.requests - 1) }, (_, i) => i).every((i) =>
              server.closedRequests.has(i),
            )
          while (
            (!settled() || (opts.cancelAfterMs !== undefined && !server.closedRequests.has(0))) &&
            Date.now() < deadline
          )
            await Bun.sleep(5)
        })
        const parts = MessageV2.parts(msg.id)
        return { result, parts, message: handle.message, server, elapsed }
      }),
    { config: () => providerCfg(server.url, opts.options) as any },
  )
}

const text = (parts: MessageV2.Part[]) =>
  parts
    .filter((p): p is MessageV2.TextPart => p.type === "text")
    .map((p) => p.text)
    .join("")

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ok = (t: string): Step => ({ kind: "stream", events: [{ text: t }], end: "stop" })
const echoTool = (calls: string[]) => ({
  echo: tool({
    description: "echo",
    inputSchema: jsonSchema<{ cmd: string }>({
      type: "object",
      properties: { cmd: { type: "string" } },
      required: ["cmd"],
    }),
    execute: async ({ cmd }) => {
      calls.push(cmd)
      return { title: "echo", output: `ran ${cmd}`, metadata: {} }
    },
  }),
})
const countOf = (parts: MessageV2.Part[], type: MessageV2.Part["type"]) => parts.filter((p) => p.type === type).length

// Backoff is irrelevant to these assertions; keep the suite fast.
let backoff: ReturnType<typeof spyOn> | undefined
const fastBackoff = (ms = 5) => (backoff = spyOn(SessionRetry, "delay").mockReturnValue(ms))
afterEach(() => backoff?.mockRestore())

// Short windows so a stall is noticed in well under a second; healthy-slow tests use wider ones.
const FAST = { headerTimeout: 400, chunkTimeout: 400 }

it.live("request is accepted but never answered: first-byte timeout aborts it and the retry succeeds", () => {
  fastBackoff()
  return runSession({ script: [{ kind: "silent" }, ok("hello")], options: FAST }).pipe(
    Effect.tap(({ result, parts, message, server }) =>
      Effect.sync(() => {
        expect(server.requests).toBe(2)
        expect(result).toBe("continue")
        expect(message.error).toBeUndefined()
        expect(text(parts)).toBe("hello")
        // the stalled connection was really closed, not merely abandoned
        expect(server.closedRequests.has(0)).toBe(true)
      }),
    ),
  )
})

it.live("goes quiet mid-stream: idle timeout aborts, partial text is discarded, the retry succeeds", () => {
  fastBackoff()
  return runSession({
    script: [
      { kind: "stream", events: [{ text: "Let me " }, { text: "think about " }], end: "silent" },
      ok("final answer"),
    ],
    options: FAST,
  }).pipe(
    Effect.tap(({ result, parts, message, server }) =>
      Effect.sync(() => {
        expect(server.requests).toBe(2)
        expect(result).toBe("continue")
        expect(message.error).toBeUndefined()
        expect(text(parts)).toBe("final answer")
        // nothing from the stalled attempt is left behind: one step, one text part
        expect(countOf(parts, "text")).toBe(1)
        expect(countOf(parts, "step-start")).toBe(1)
        expect(server.closedRequests.has(0)).toBe(true)
      }),
    ),
  )
})

it.live("a Bedrock event-stream content type (any letter case) gets the same idle watchdog as SSE", () => {
  fastBackoff()
  return runSession({
    script: [
      { kind: "stream", contentType: "Application/Vnd.Amazon.EventStream", events: [{ text: "x" }], end: "silent" },
      ok("done"),
    ],
    options: FAST,
  }).pipe(
    Effect.tap(({ result, message, server }) =>
      Effect.sync(() => {
        expect(server.requests).toBe(2)
        expect(result).toBe("continue")
        expect(message.error).toBeUndefined()
      }),
    ),
  )
})

it.live("connection reset mid-stream: partial text is discarded and the retry succeeds", () => {
  fastBackoff()
  return runSession({
    script: [{ kind: "stream", events: [{ text: "partial " }], end: "reset" }, ok("complete")],
    options: FAST,
  }).pipe(
    Effect.tap(({ result, parts, message, server }) =>
      Effect.sync(() => {
        expect(server.requests).toBe(2)
        expect(result).toBe("continue")
        expect(message.error).toBeUndefined()
        expect(text(parts)).toBe("complete")
        expect(countOf(parts, "text")).toBe(1)
        expect(countOf(parts, "step-start")).toBe(1)
      }),
    ),
  )
})

it.live("a slow but healthy stream is NOT cut off (late first byte, slow steady chunks)", () =>
  runSession({
    script: [
      {
        kind: "stream",
        delayMs: 600, // first byte well after most of the window, still inside it
        gapMs: 400, // each gap inside the idle window; the whole stream outlasts it
        events: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }, { text: "e" }],
        end: "stop",
      },
    ],
    options: { headerTimeout: 1500, chunkTimeout: 1000 },
  }).pipe(
    Effect.tap(({ result, parts, message, server, elapsed }) =>
      Effect.sync(() => {
        expect(elapsed).toBeGreaterThan(1500) // outlived both windows, so the test is not vacuous
        expect(server.requests).toBe(1)
        expect(result).toBe("continue")
        expect(message.error).toBeUndefined()
        expect(text(parts)).toBe("abcde")
      }),
    ),
  ),
)

it.live("partially streamed tool call (input still pending) is discarded and the tool runs exactly once", () => {
  fastBackoff()
  const calls: string[] = []
  return runSession({
    tools: echoTool(calls),
    script: [
      { kind: "stream", events: [{ tool: { id: "call_1", name: "echo", args: '{"cmd":"ec' } }], end: "silent" },
      { kind: "stream", events: [{ tool: { id: "call_1", name: "echo", args: '{"cmd":"go"}' } }], end: "tool_calls" },
    ],
    options: FAST,
  }).pipe(
    Effect.tap(({ parts, message, server }) =>
      Effect.sync(() => {
        expect(server.requests).toBe(2)
        expect(message.error).toBeUndefined()
        expect(calls).toEqual(["go"])
        const toolParts = parts.filter((p): p is MessageV2.ToolPart => p.type === "tool")
        expect(toolParts).toHaveLength(1)
        expect(toolParts[0].state.status).toBe("completed")
      }),
    ),
  )
})

it.live("a tool call already dispatched is never re-run: the stall is reported instead of retried", () => {
  fastBackoff()
  const calls: string[] = []
  return runSession({
    tools: echoTool(calls),
    script: [
      { kind: "stream", events: [{ tool: { id: "call_1", name: "echo", args: '{"cmd":"rm"}' } }], end: "silent" },
      { kind: "stream", events: [{ tool: { id: "call_1", name: "echo", args: '{"cmd":"rm"}' } }], end: "tool_calls" },
    ],
    options: FAST,
  }).pipe(
    Effect.tap(({ result, message, server }) =>
      Effect.sync(() => {
        expect(calls).toEqual(["rm"]) // ran once, and only once
        expect(server.requests).toBe(1) // no second request that would re-emit the call
        expect(result).toBe("stop")
        expect(message.error?.name).toBe("APIError")
        const msg = (message.error?.data as { message: string }).message
        expect(msg).toContain("The model stopped responding")
        expect(msg).toContain("not retried")
        expect(msg).toContain("echo")
      }),
    ),
  )
})

it.live("retries are bounded and exhaustion ends the session with a clear 'model stopped responding' error", () => {
  fastBackoff()
  return runSession({ script: Array.from({ length: 20 }, () => ({ kind: "silent" }) as Step), options: FAST }).pipe(
    Effect.tap(({ result, message, server }) =>
      Effect.sync(() => {
        expect(server.requests).toBe(1 + SessionRetry.RETRY_MAX_ATTEMPTS)
        expect(result).toBe("stop")
        expect(message.error?.name).toBe("APIError")
        const msg = (message.error?.data as { message: string }).message
        expect(msg).toContain("The model stopped responding")
        expect(msg).toContain(`gave up after ${SessionRetry.RETRY_MAX_ATTEMPTS} retries`)
      }),
    ),
  )
})

it.live("user cancel during the first-byte wait ends the session at once and is not treated as a stall", () => {
  fastBackoff()
  return runSession({
    script: [{ kind: "silent" }, ok("never reached")],
    options: { headerTimeout: 10_000, chunkTimeout: 10_000 },
    cancelAfterMs: 100,
  }).pipe(
    Effect.tap(({ message, server, elapsed }) =>
      Effect.sync(() => {
        expect(elapsed).toBeLessThan(3000) // far below the 10s windows: the abort did it
        expect(server.requests).toBe(1)
        expect(message.error?.name).toBe("MessageAbortedError")
        expect(server.closedRequests.has(0)).toBe(true)
      }),
    ),
  )
})

it.live("user cancel during the retry backoff ends the session at once and sends no further request", () => {
  fastBackoff(30_000)
  return runSession({
    script: [{ kind: "silent" }, ok("never reached")],
    options: FAST,
    cancelAfterMs: 50,
    cancelAfterStall: true, // the header timeout has fired and the session is sleeping in backoff
  }).pipe(
    Effect.tap(({ message, server, elapsed }) =>
      Effect.sync(() => {
        expect(elapsed).toBeLessThan(5000)
        expect(server.requests).toBe(1)
        expect(message.error?.name).toBe("MessageAbortedError")
      }),
    ),
  )
})

it.live("every stall timer is cleared: none outlive the request, stalled or healthy", () => {
  fastBackoff()
  // Unusual durations identify this suite's own watchdog timers among everything else using setTimeout.
  const HEADER = 777
  const CHUNK = 888
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const live = new Set<unknown>()
  let created = 0
  globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => {
    if (ms !== HEADER && ms !== CHUNK) return realSet(fn, ms, ...rest)
    created++
    const id: unknown = realSet(
      (...a: any[]) => {
        live.delete(id)
        return fn(...a)
      },
      ms,
      ...rest,
    )
    live.add(id)
    return id
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: any) => {
    live.delete(id)
    return realClear(id)
  }) as typeof clearTimeout
  const restore = () => {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
  return runSession({
    // one stalled attempt (timer fires), one healthy multi-chunk attempt (timers cleared as chunks arrive)
    script: [{ kind: "silent" }, { kind: "stream", events: [{ text: "a" }, { text: "b" }], end: "stop" }],
    options: { headerTimeout: HEADER, chunkTimeout: CHUNK },
  }).pipe(
    Effect.tap(({ message }) =>
      Effect.sync(() => {
        expect(message.error).toBeUndefined()
        expect(created).toBeGreaterThan(2)
        expect(live.size).toBe(0)
      }),
    ),
    Effect.ensuring(Effect.sync(restore)),
  )
})

it.live("with no headerTimeout configured a 300s first-byte timer is armed and cleared once headers arrive", () => {
  const DEFAULT = 300_000
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const live = new Set<unknown>()
  let created = 0
  globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => {
    const id = realSet(fn, ms, ...rest)
    if (ms === DEFAULT) {
      created++
      live.add(id)
    }
    return id
  }) as typeof setTimeout
  globalThis.clearTimeout = ((id: any) => {
    live.delete(id)
    return realClear(id)
  }) as typeof clearTimeout
  return runSession({ script: [ok("hi")], options: { chunkTimeout: 555 } }).pipe(
    Effect.tap(({ message }) =>
      Effect.sync(() => {
        expect(message.error).toBeUndefined()
        expect(created).toBe(1) // the default first-byte timer, nothing else uses 300s here
        expect(live.size).toBe(0)
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        globalThis.setTimeout = realSet
        globalThis.clearTimeout = realClear
      }),
    ),
  )
})

// Direct tests of the discard rule on a hand-built message (the SDK cannot be made to emit these orderings).
const seed = (parts: Array<Record<string, unknown>>, prior: Array<Record<string, unknown>> = []) =>
  provideTmpdirInstanceLegacy((dir) =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const chat = yield* session.create({})
      const messageID = MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        role: "assistant",
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        parentID: MessageID.ascending(),
        time: { created: Date.now() },
        finish: "end_turn",
      } as any)
      for (const part of prior)
        yield* session.updatePart({ id: PartID.ascending(), messageID, sessionID: chat.id, ...part } as any)
      const before = StallRecovery.partIDs(messageID)
      for (const part of parts)
        yield* session.updatePart({ id: PartID.ascending(), messageID, sessionID: chat.id, ...part } as any)
      const result = yield* Effect.promise(() =>
        StallRecovery.discardAttempt({ sessionID: chat.id, messageID, before }),
      )
      return { result, left: MessageV2.parts(messageID).map((p) => p.type) }
    }),
  )
const pendingTool = { type: "tool", tool: "echo", callID: "c1", state: { status: "pending", input: {}, raw: "" } }
const runningTool = {
  type: "tool",
  tool: "echo",
  callID: "c2",
  state: { status: "running", input: {}, time: { start: 1 } },
}

it.live("discard removes streamed text, reasoning, step-start and pending tool input", () =>
  seed([
    { type: "step-start" },
    { type: "reasoning", text: "r", time: { start: 1 } },
    { type: "text", text: "t" },
    pendingTool,
  ]).pipe(
    Effect.tap(({ result, left }) =>
      Effect.sync(() => {
        expect(result.ok).toBe(true)
        expect(left).toEqual([])
      }),
    ),
  ),
)

it.live("discard leaves parts that predate the failed attempt untouched", () =>
  seed(
    [{ type: "text", text: "from the attempt" }],
    [
      { type: "text", text: "earlier step" },
      {
        type: "tool",
        tool: "echo",
        callID: "old",
        state: { status: "completed", input: {}, output: "o", title: "t", metadata: {}, time: { start: 1, end: 2 } },
      },
    ],
  ).pipe(
    Effect.tap(({ result, left }) =>
      Effect.sync(() => {
        expect(result.ok).toBe(true)
        expect(left).toEqual(["text", "tool"]) // only the attempt's own text was removed
      }),
    ),
  ),
)

it.live("discard refuses, and removes nothing, once a tool call has started", () =>
  seed([{ type: "text", text: "t" }, pendingTool, runningTool]).pipe(
    Effect.tap(({ result, left }) =>
      Effect.sync(() => {
        expect(result).toEqual({ ok: false, dispatched: ["echo"] })
        expect(left).toEqual(["text", "tool", "tool"])
      }),
    ),
  ),
)

it.live("discard refuses once the attempt has finished its step (no double-counted cost)", () =>
  seed([
    { type: "step-start" },
    { type: "text", text: "t" },
    {
      type: "step-finish",
      reason: "stop",
      cost: 1,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ]).pipe(
    Effect.tap(({ result, left }) =>
      Effect.sync(() => {
        expect(result).toEqual({ ok: false, dispatched: ["step-finish"] })
        expect(left).toEqual(["step-start", "text", "step-finish"])
      }),
    ),
  ),
)

describe("tool-call id bookkeeping across a discarded attempt", () => {
  test("a retry reusing the raw id pairs with its own start and never collides with an earlier call", () => {
    const ids = SessionProcessor.createToolCallIDCoercer("msg")
    // an earlier call in the same message completed under raw id "call_1"
    const first = ids.start("call_1")
    ids.call("call_1")
    ids.result("call_1", first)
    // the stalled attempt started the same raw id, never called it, and was discarded
    const stale = ids.start("call_1")
    ids.discardUnstarted()
    // the retry reuses the raw id
    const retried = ids.start("call_1")
    expect(ids.call("call_1")).toBe(retried)
    expect(retried).not.toBe(first)
    expect(stale).not.toBe(first)
  })

  test("execution ordinals stay aligned: the retried call resolves to its own id, not the discarded one", () => {
    const ids = SessionProcessor.createToolCallIDCoercer("msg")
    ids.start("") // empty raw id: repeats across attempts
    ids.discardUnstarted()
    const retried = ids.start("")
    ids.call("")
    const execution = ids.beginExecution("")
    expect(ids.executionID(execution)).toBe(retried)
    ids.finishExecution(execution)
    expect(ids.settled("")).toBe(retried)
  })
})

describe("stall classification and defaults", () => {
  const providerID = ProviderID.make("test")

  test("a header timeout is a retryable APIError that says the model stopped responding", () => {
    const error = MessageV2.fromError(new ProviderError.HeaderTimeoutError(120_000), { providerID })
    expect(error.name).toBe("APIError")
    expect((error.data as any).message).toBe("The model stopped responding: no response headers within 120s")
    expect(SessionRetry.retryable(error)).toContain("The model stopped responding")
  })

  test("an idle-stream timeout is a retryable APIError that says the model stopped responding", () => {
    const error = MessageV2.fromError(new ProviderError.ResponseStreamError(ProviderError.SSE_IDLE_MESSAGE), {
      providerID,
    })
    expect(error.name).toBe("APIError")
    expect((error.data as any).message).toContain("The model stopped responding")
    expect(SessionRetry.retryable(error)).toBeDefined()
  })

  test("other stream failures (websocket transport) keep their previous, non-retried handling", () => {
    const error = MessageV2.fromError(new ProviderError.ResponseStreamError("WebSocket closed"), { providerID })
    expect(error.name).toBe("UnknownError")
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("a user abort is still an abort, not a stall", () => {
    const error = MessageV2.fromError(new DOMException("Aborted", "AbortError"), { providerID })
    expect(error.name).toBe("MessageAbortedError")
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })
})
