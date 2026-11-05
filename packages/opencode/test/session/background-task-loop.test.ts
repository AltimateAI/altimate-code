/**
 * Background subagents through the real prompt loop with a mock LLM: a child's result is never
 * lost or silently replaced. The parent and its child share the mock server; requests are told
 * apart by the parent's first user text, which a child never sees.
 */
import { afterAll, beforeAll, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { MessageID, type SessionID } from "../../src/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { testEffect } from "../lib/effect"
import { TestLLMServer, raw, reply, type Item, type Reply } from "../lib/llm-server"
import { provideTmpdirServerLegacy } from "./legacy-instance"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    remove: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    entry: () => Effect.succeed(undefined),
    listMeta: () => Effect.succeed(undefined),
    snapshot: () => Effect.succeed({ tools: {}, meta: undefined }),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make(TestLLMServer.layer, []),
])
const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [
      LayerNode.replace(MCP.node, mcp),
      LayerNode.replace(LSP.node, lsp),
      LayerNode.replace(
        RuntimeFlags.node,
        RuntimeFlags.layer({ experimentalEventSystem: true, experimentalBackgroundSubagents: true }),
      ),
    ],
  }),
)

// The imperative prompt path builds its tools without RuntimeFlags, from the environment.
const FLAG = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"
let previousFlag: string | undefined
beforeAll(() => {
  previousFlag = process.env[FLAG]
  process.env[FLAG] = "true"
})
afterAll(() => {
  if (previousFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = previousFlag
})

const providerCfg = (url: string) => ({
  provider: {
    "altimate-backend": {
      name: "Altimate (test)",
      id: "altimate-backend",
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
      options: { apiKey: "test-key", baseURL: url },
    },
  },
  model: "altimate-backend/test-model",
})

const PARENT = "PARENT-TURN"
const CHILD = "CHILDWORK"
type Hit = { body: Record<string, unknown> }
const text = (hit: Hit) => JSON.stringify(hit.body)
const isParent = (hit: Hit) => text(hit).includes(PARENT)
const isChild = (hit: Hit) => !isParent(hit) && text(hit).includes(CHILD)
const taskIdIn = (hit: Hit) => /task_id: (ses_[A-Za-z0-9]+)/.exec(text(hit))?.[1]

const launch = { description: "scan", prompt: CHILD, subagent_type: "general", background: true }
const join = (taskID: string, description = "collect") => ({
  description,
  prompt: "collect the result",
  subagent_type: "general",
  task_id: taskID,
})

const chunk = (delta: Record<string, unknown>, finish?: string) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
})

/** One assistant step with several tool calls (`Reply.tool` puts every call at index 0). */
function toolCalls(...calls: { name: string; input: unknown }[]): Item {
  return raw({
    head: [chunk({ role: "assistant" })],
    tail: [
      ...calls.flatMap((call, index) => [
        chunk({
          tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name: call.name, arguments: "" } }],
        }),
        chunk({ tool_calls: [{ index, function: { arguments: JSON.stringify(call.input) } }] }),
      ]),
      chunk({}, "tool_calls"),
    ],
  })
}

/** A parent reply built when its request arrives, so it can name the task_id the launch returned. */
function lazy(build: (taskID: string) => Reply | Item): [(hit: Hit) => boolean, Item] {
  const slot = raw({})
  return [
    (hit) => {
      if (!isParent(hit)) return false
      const taskID = taskIdIn(hit)
      if (!taskID) return false
      const built = build(taskID)
      Object.assign(slot, "item" in built ? built.item() : built)
      return true
    },
    slot,
  ]
}

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

const poll = <A, E, R>(read: () => Effect.Effect<A | undefined, E, R>, label: string, ms = 10_000) =>
  Effect.gen(function* () {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const value = yield* read()
      if (value !== undefined) return value
      yield* Effect.sleep("20 millis")
    }
    throw new Error(`timed out waiting for ${label}`)
  })

const taskParts = (messages: SessionV1.WithParts[]) =>
  messages.flatMap((message) =>
    message.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task"),
  )

/** The child's request has started streaming its partial text (persisted when the stream ends). */
const childStreaming = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  yield* poll(() => Effect.map(llm.hits, (hits) => (hits.some(isChild) ? true : undefined)), "child request")
  yield* Effect.sleep("300 millis")
})

const startSession = Effect.gen(function* () {
  const sessions = yield* Session.Service
  return yield* sessions.create({
    title: "background tasks",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
})

const userTurn = (sessionID: SessionID, value: string) =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    return yield* prompt.prompt({
      sessionID,
      messageID: MessageID.ascending(),
      agent: "build",
      parts: [{ type: "text", text: `${PARENT} ${value}` }],
    })
  })

it.live(
  "ending the turn without collecting cancels the child visibly, and a later collect returns its partial findings",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* Session.Service
        const session = yield* startSession
        const parentDone = gate()
        yield* llm.pushMatch(isParent, reply().tool("task", launch))
        yield* llm.pushMatch(isChild, reply().text("PARTIALFINDING").hang())
        yield* llm.pushMatch(isParent, reply().wait(parentDone.promise).text("Started it. I will be notified.").stop())

        const turn = yield* userTurn(session.id, "one").pipe(Effect.forkChild)
        const launched = yield* poll(
          () =>
            Effect.gen(function* () {
              const part = taskParts(yield* sessions.messages({ sessionID: session.id }))[0]
              return part?.state.status === "completed" ? part : undefined
            }),
          "launch",
        )
        if (launched.state.status !== "completed") throw new Error("launch not completed")
        const childID = launched.state.metadata?.sessionId as SessionID
        expect(launched.state.output).toContain(`task_id=${childID}`)
        expect(launched.state.output).toContain("cancelled if your turn ends before you collect it")
        yield* childStreaming
        parentDone.open()
        yield* Fiber.join(turn)

        // The launch part now records the cancellation and the partial findings.
        const annotated = yield* poll(
          () =>
            Effect.gen(function* () {
              const part = taskParts(yield* sessions.messages({ sessionID: session.id }))[0]
              return part?.state.status === "completed" &&
                part.state.output.includes("was cancelled at the end of the turn")
                ? part
                : undefined
            }),
          "cancellation record on the launch part",
        )
        if (annotated.state.status !== "completed") throw new Error("unreachable")
        expect(annotated.state.output).toContain(`Background task ${childID} was cancelled at the end of the turn`)
        expect(annotated.state.output).toContain("PARTIALFINDING")
        expect(annotated.state.metadata?.interrupted).toBe(true)

        // Next turn: collecting returns the recorded partial findings and never re-prompts the child.
        yield* llm.pushMatch(isParent, reply().tool("task", join(childID)))
        yield* llm.pushMatch(isParent, reply().text("final").stop())
        yield* userTurn(session.id, "two")

        const parts = taskParts(yield* sessions.messages({ sessionID: session.id }))
        const collected = parts[parts.length - 1]
        if (collected.state.status !== "completed") throw new Error(`collect ended ${collected.state.status}`)
        expect(collected.state.output).toContain("PARTIALFINDING")
        expect(collected.state.output).toContain("Task interrupted")
        expect(collected.state.metadata?.interrupted).toBe(true)
        const hits = yield* llm.hits
        expect(hits.filter((hit) => !isParent(hit) && text(hit).includes("collect the result"))).toHaveLength(0)
        const child = yield* sessions.messages({ sessionID: childID })
        expect(child.filter((message) => message.info.role === "user")).toHaveLength(1)
      }),
      { git: true, config: providerCfg },
    ),
  { timeout: 30_000 },
)

it.live(
  "parallel and repeated collects return the same result and prompt the child once",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* Session.Service
        const session = yield* startSession
        const childDone = gate()
        yield* llm.pushMatch(isParent, reply().tool("task", launch))
        yield* llm.pushMatch(isChild, reply().wait(childDone.promise).text("CHILDRESULT").stop())
        yield* llm.pushMatch(
          ...lazy((id) =>
            toolCalls({ name: "task", input: join(id, "join a") }, { name: "task", input: join(id, "join b") }),
          ),
        )
        yield* llm.pushMatch(...lazy((id) => reply().tool("task", join(id, "join c"))))
        yield* llm.pushMatch(isParent, reply().text("final").stop())

        const turn = yield* userTurn(session.id, "one").pipe(Effect.forkChild)
        yield* poll(
          () =>
            Effect.gen(function* () {
              const parts = taskParts(yield* sessions.messages({ sessionID: session.id }))
              return parts.filter((part) => part.state.status === "running").length === 2 ? true : undefined
            }),
          "two running joins",
        )
        childDone.open()
        yield* Fiber.join(turn)

        const parts = taskParts(yield* sessions.messages({ sessionID: session.id }))
        const joins = parts.filter((part) => part.state.status === "completed" && part.state.input.task_id)
        expect(joins).toHaveLength(3)
        const outputs = joins.map((part) => (part.state.status === "completed" ? part.state.output : ""))
        for (const output of outputs) expect(output).toContain("<task_result>\nCHILDRESULT\n</task_result>")
        expect(new Set(outputs).size).toBe(1)
        const hits = yield* llm.hits
        expect(hits.filter(isChild)).toHaveLength(1)
      }),
      { git: true, config: providerCfg },
    ),
  { timeout: 30_000 },
)

it.live(
  "an errored child gives the same outcome on every collect and is not re-run",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* Session.Service
        const session = yield* startSession
        yield* llm.pushMatch(isParent, reply().tool("task", launch))
        yield* llm.pushMatch(isChild, { type: "http-error", status: 400, body: { error: { message: "CHILDBROKE" } } })
        yield* llm.pushMatch(...lazy((id) => reply().tool("task", join(id, "join a"))))
        yield* llm.pushMatch(...lazy((id) => reply().tool("task", join(id, "join b"))))
        yield* llm.pushMatch(isParent, reply().text("final").stop())

        yield* userTurn(session.id, "one")

        const parts = taskParts(yield* sessions.messages({ sessionID: session.id }))
        const joins = parts.filter((part) => part.state.input.task_id)
        expect(joins).toHaveLength(2)
        const outcome = (part: SessionV1.ToolPart) =>
          part.state.status === "completed"
            ? { status: part.state.status, output: part.state.output }
            : part.state.status === "error"
              ? { status: part.state.status, output: part.state.error }
              : { status: part.state.status, output: "" }
        expect(outcome(joins[1])).toEqual(outcome(joins[0]))
        const hits = yield* llm.hits
        expect(hits.filter(isChild)).toHaveLength(1)
        expect(hits.filter((hit) => !isParent(hit) && text(hit).includes("collect the result"))).toHaveLength(0)
      }),
      { git: true, config: providerCfg },
    ),
  { timeout: 30_000 },
)

it.live(
  "cancelling the parent while it waits on a collect keeps the child's partial findings",
  () =>
    provideTmpdirServerLegacy(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* startSession
        yield* llm.pushMatch(isParent, reply().tool("task", launch))
        yield* llm.pushMatch(isChild, reply().text("PARTIALFINDING").hang())
        yield* llm.pushMatch(...lazy((id) => reply().tool("task", join(id))))

        const turn = yield* userTurn(session.id, "one").pipe(Effect.forkChild)
        const childID = yield* poll(
          () =>
            Effect.gen(function* () {
              const parts = taskParts(yield* sessions.messages({ sessionID: session.id }))
              const running = parts.find((part) => part.state.status === "running" && part.state.input.task_id)
              return running?.state.input.task_id as SessionID | undefined
            }),
          "running collect",
        )
        yield* childStreaming
        yield* prompt.cancel(session.id)
        yield* Fiber.await(turn)

        const collected = yield* poll(
          () =>
            Effect.gen(function* () {
              const parts = taskParts(yield* sessions.messages({ sessionID: session.id }))
              const part = parts.find((part) => part.state.input.task_id)
              return part && part.state.status !== "running" && part.state.status !== "pending" ? part : undefined
            }),
          "settled collect",
        )
        if (collected.state.status !== "completed") {
          throw new Error(`collect ended ${collected.state.status}: ${JSON.stringify(collected.state)}`)
        }
        expect(collected.state.output).toContain("Task interrupted. These are partial findings")
        expect(collected.state.output).toContain("PARTIALFINDING")
      }),
      { git: true, config: providerCfg },
    ),
  { timeout: 30_000 },
)
