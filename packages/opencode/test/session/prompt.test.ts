import { NodeFileSystem } from "@effect/platform-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
// altimate_change start - scoped in-process provider stream for learn loop coverage
import { spyOn } from "bun:test"
import { Delivery as LessonDelivery } from "../../src/altimate/learn/delivery"
import * as LessonStore from "../../src/altimate/learn/store"
// altimate_change end
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { NamedError } from "@opencode-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { GlobalBus } from "../../src/bus/global"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session as LegacySession } from "../../src/session"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { Shell } from "@opencode-ai/core/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Format } from "../../src/format"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderID, ModelID } from "@/provider/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { withLegacyInstanceRunner } from "./legacy-instance"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

// Core-branded model ref for SessionV1 message/part fixtures (Session.Service.updateMessage,
// seed assistants, subtask parts, and .info.model assertions all use ProviderV2.ID/ModelV2.ID).
const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// Fork-branded model ref for SessionPrompt.PromptInput.model (ProviderID/ModelID).
const promptRef = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    listMeta: () => Effect.succeed(undefined),
    snapshot: () => Effect.succeed({ tools: {}, meta: undefined }),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    remove: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    entry: () => Effect.succeed(undefined),
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

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

function makePrompt(input?: { processor?: "blocking" }) {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    FSUtil.defaultLayer,
    BackgroundJob.defaultLayer,
    status,
    Database.defaultLayer,
    EventV2Bridge.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc =
    input?.processor === "blocking"
      ? blockingProcessor
      : SessionProcessor.layer.pipe(
          Layer.provide(summary),
          Layer.provide(Image.defaultLayer),
          Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
          Layer.provideMerge(deps),
        )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

function makeHttp(input?: { processor?: "blocking" }) {
  return Layer.mergeAll(TestLLMServer.layer, makePrompt(input))
}

function makeHttpNoLLMServer(input?: { processor?: "blocking" }) {
  return makePrompt(input)
}

const it = withLegacyInstanceRunner(testEffect(makeHttp()))
const noLLMServer = withLegacyInstanceRunner(testEffect(makeHttpNoLLMServer()))
const raceNoLLMServer = withLegacyInstanceRunner(testEffect(makeHttpNoLLMServer({ processor: "blocking" })))
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// altimate_change start - approved-lesson prompt integration fixtures
function approvedLesson(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id, text, tags: [], scope: "project", helpful: 0, harmful: 0, applied: 0,
    created: "2026-09-30T00:00:00.000Z", updated: "2026-09-30T00:00:00.000Z", ...extra,
  }
}

function requestMessages(input: Record<string, unknown>) {
  if (!Array.isArray(input.messages)) throw new Error("expected chat completion messages")
  return input.messages as { role: string; content: unknown }[]
}

function requestText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => requestText(part?.text)).join("\n")
  return ""
}

function systemBytes(input: Record<string, unknown>) {
  return JSON.stringify(requestMessages(input).filter((message) => message.role === "system"))
}
// altimate_change end

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
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
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const ensureDir = Effect.fn("test.ensureDir")(function* (dir: string) {
  const fs = yield* FSUtil.Service
  yield* fs.ensureDir(dir)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// altimate_change start - approved lessons are harness-delivered without changing cached prefixes
for (const change of ["lower budget", "replacement", "disabled config", "disabled env"] as const) {
  noLLMServer.instance(
    `learn resumed request ignores persisted notes after ${change}`,
    () => Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const rule = "Validate depreciation schedules against fiscal_year boundaries."
      yield* writeText(path.join(dir, ".altimate-code/learn/team/approved.json"), JSON.stringify([
        approvedLesson("L-0001", rule, { tags: ["depreciation"] }),
      ]))
      const { prompt, chat, sessions } = yield* boot()
      const request = yield* user(chat.id, "Review depreciation schedules.")
      const staleRule = change === "replacement" ? "Keep the previous depreciation guidance." : rule
      const { cached, staleID } = yield* Effect.promise(async () => {
        const delivery = new LessonDelivery(dir, { core_lessons: 0, retrieved_lessons: 0, budget_tokens: 100 })
        await delivery.prepare(chat.id, "initial-message", "Hello.")
        const cached = await delivery.prepare(chat.id, request.id, "Review depreciation schedules.")
        const part = await SessionPrompt.attachTeamRules(
          { info: { ...request, model: promptRef }, parts: [] },
          `Team rules for this request:\n${staleRule}`,
          delivery,
          (part) => Effect.runPromise(sessions.updatePart(part)),
        )
        return { cached, staleID: part!.id }
      })
      expect(cached.requestNote).toContain(rule)
      const clientID = PartID.ascending()
      yield* sessions.updatePart({
        id: clientID, sessionID: chat.id, messageID: request.id, type: "text",
        text: "Client text must survive", synthetic: true, metadata: { learnRequest: true },
      })
      const previous = process.env.ALTIMATE_LEARN
      if (change === "disabled env") process.env.ALTIMATE_LEARN = "0"
      const captured: LLM.StreamInput["messages"][] = []
      const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
        captured.push(structuredClone(input.messages))
        const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
        async function* fullStream() {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start", id: "reply" }
          yield { type: "text-delta", id: "reply", text: "Done." }
          yield { type: "text-end", id: "reply" }
          yield { type: "finish-step", finishReason: "stop", usage }
          yield { type: "finish", finishReason: "stop", totalUsage: usage }
        }
        return { fullStream: fullStream() } as unknown as Awaited<ReturnType<typeof LLM.stream>>
      })
      try {
        const result = yield* prompt.loop({ sessionID: chat.id })
        expect(result.info).not.toHaveProperty("error")
        expect(captured).toHaveLength(1)
        expect(JSON.stringify(captured)).not.toContain(staleRule)
        expect(JSON.stringify(captured)).toContain("Client text must survive")
        if (change === "replacement") expect(JSON.stringify(captured)).toContain(rule)
        const messages = yield* sessions.messages({ sessionID: chat.id })
        const parts = messages.find((message) => message.info.id === request.id)!.parts
        expect(parts.find((part) => part.id === staleID)).toMatchObject({ ignored: true })
        expect(parts.find((part) => part.id === clientID)).not.toHaveProperty("ignored")
        const active = parts.filter((part) => part.type === "text" && part.metadata?.learnRequest && !part.ignored && part.id !== clientID)
        expect(active).toHaveLength(change === "replacement" ? 1 : 0)
      } finally {
        stream.mockRestore()
        if (previous === undefined) delete process.env.ALTIMATE_LEARN
        else process.env.ALTIMATE_LEARN = previous
      }
    }),
    { config: { ...cfg, snapshot: false, learn: { enabled: change !== "disabled config", capture: false, core_lessons: 0, retrieved_lessons: 0, budget_tokens: change === "lower budget" ? 0 : 100 } } },
    30_000,
  )
}

for (const disabledBy of ["env", "config"] as const) {
  const learn = { enabled: disabledBy !== "config", capture: false, core_lessons: 1, retrieved_lessons: 1 }
  noLLMServer.instance(
    `learn kill switch skips delivery and bookkeeping when disabled by ${disabledBy}`,
    () => Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const root = path.join(dir, ".altimate-code/learn")
      const rule = "Store invoice totals using integer amount_cents values."
      const approved = JSON.stringify([approvedLesson("L-0001", rule, { pinned: true })])
      yield* writeText(path.join(root, "team/approved.json"), approved)
      const previous = process.env.ALTIMATE_LEARN
      if (disabledBy === "env") process.env.ALTIMATE_LEARN = "FaLsE"
      else delete process.env.ALTIMATE_LEARN
      const section = spyOn(LessonDelivery.prototype, "section")
      const captured: Pick<LLM.StreamInput, "system" | "messages">[] = []
      const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
        captured.push({ system: [...input.system], messages: structuredClone(input.messages) })
        const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
        async function* fullStream() {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start", id: "reply" }
          yield { type: "text-delta", id: "reply", text: "Done." }
          yield { type: "text-end", id: "reply" }
          yield { type: "finish-step", finishReason: "stop", usage }
          yield { type: "finish", finishReason: "stop", totalUsage: usage }
        }
        return { fullStream: fullStream() } as unknown as Awaited<ReturnType<typeof LLM.stream>>
      })
      try {
        const { prompt, chat } = yield* boot()
        const result = yield* prompt.prompt({
          sessionID: chat.id, agent: "build", model: promptRef, parts: [{ type: "text", text: "Review invoice totals." }],
        })
        expect(result.info.role).toBe("assistant")
        expect(result.info).not.toHaveProperty("error")
        expect(captured).toHaveLength(1)
        expect(JSON.stringify(captured)).not.toContain(rule)
        expect(section).not.toHaveBeenCalled()
        const fs = yield* FSUtil.Service
        for (const file of [".sessions", "team/shown.jsonl", "team/usage.json"]) {
          expect(yield* fs.exists(path.join(root, file))).toBe(false)
        }
        expect(yield* fs.readFileStringSafe(path.join(root, "team/approved.json"))).toBe(approved)
      } finally {
        stream.mockRestore()
        section.mockRestore()
        if (previous === undefined) delete process.env.ALTIMATE_LEARN
        else process.env.ALTIMATE_LEARN = previous
      }
    }),
    { config: { ...cfg, snapshot: false, learn } },
    30_000,
  )
}

for (const { missingMetadata, batched } of [
  { missingMetadata: false, batched: false },
  { missingMetadata: true, batched: false },
  { missingMetadata: false, batched: true },
]) {
  noLLMServer.instance(
    `learn real loop preserves cache prefixes and delivers request and file rules without sockets (missing metadata: ${missingMetadata}, batch: ${batched})`,
    () => Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const core = "Store invoice totals using integer amount_cents values."
      const requestRule = "Validate depreciation schedules against fiscal_year boundaries."
      const fileRule = "Use explicit source schemas for these model files."
      yield* writeText(path.join(dir, ".altimate-code/learn/team/approved.json"), JSON.stringify([
        approvedLesson("L-0001", core, { pinned: true }),
        approvedLesson("L-0002", requestRule, { tags: ["depreciation"], trigger: { paths: ["models/staging/**"] } }),
        approvedLesson("L-0003", fileRule, { trigger: { paths: ["models/**"] } }),
      ]))
      const filePath = path.join(dir, "models/report.sql")
      yield* writeText(filePath, "select 1\n")
      const registryTools = ToolRegistry.tools
      const registry = spyOn(ToolRegistry, "tools").mockImplementation(async (...args) => {
        const tools = await registryTools(...args)
        return tools.map((item) => !missingMetadata || item.id !== "read" ? item : {
          ...item,
          execute: (...args) => item.execute(...args).pipe(Effect.map((result) => {
            delete (result as { metadata?: unknown }).metadata
            return result
          })),
        })
      })
      const captured: Pick<LLM.StreamInput, "system" | "messages">[] = []
      const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
        const step = captured.length
        captured.push({ system: [...input.system], messages: structuredClone(input.messages) })
        const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
        async function* fullStream() {
          yield { type: "start" }
          yield { type: "start-step" }
          if (step === 0) {
            const toolCallId = "learn-read"
            const toolName = batched ? "batch" : "read"
            const args = batched ? { tool_calls: [{ tool: "read", parameters: { filePath } }] } : { filePath }
            yield { type: "tool-input-start", id: toolCallId, toolName }
            yield { type: "tool-call", toolCallId, toolName, input: args }
            const output = await input.tools[toolName].execute!(args, {
              toolCallId, messages: input.messages, abortSignal: input.abort,
            })
            yield { type: "tool-result", toolCallId, toolName, input: args, output }
          } else {
            yield { type: "text-start", id: "reply" }
            yield { type: "text-delta", id: "reply", text: "Done." }
            yield { type: "text-end", id: "reply" }
          }
          yield { type: "finish-step", finishReason: step === 0 ? "tool-calls" : "stop", usage }
          yield { type: "finish", finishReason: step === 0 ? "tool-calls" : "stop", totalUsage: usage }
        }
        return { fullStream: fullStream() } as unknown as Awaited<ReturnType<typeof LLM.stream>>
      })
      try {
        const { prompt, chat, sessions } = yield* boot()
        for (const text of ["Hello.", "Review depreciation schedules.", "Review depreciation schedules again."]) {
          const result = yield* prompt.prompt({
            sessionID: chat.id, agent: "build", model: promptRef, parts: [{ type: "text", text }],
          })
          expect(result.info.role).toBe("assistant")
          expect(result.info).not.toHaveProperty("error")
        }

        expect(captured).toHaveLength(4)
        expect(captured[0].system.join("\n")).toContain(`## Team rules\n${core}`)
        for (const input of captured) expect(input.system).toEqual(captured[0].system)
        expect(JSON.stringify(captured[1].messages)).toContain(`Team rules for models/report.sql:\\n[applies to: models/**] ${fileRule}`)
        const secondUser = captured[2].messages.at(-1)!
        expect(secondUser.role).toBe("user")
        expect(secondUser.content).toEqual([
          { type: "text", text: "Review depreciation schedules." },
          { type: "text", text: `Team rules for this request:\n[applies to: models/staging/**] ${requestRule}` },
        ])
        expect(JSON.stringify(captured[3].messages.at(-1))).not.toContain("Team rules for this request:")
        expect(JSON.stringify(captured[3].messages).split("Team rules for this request:")).toHaveLength(2)

        const messages = yield* sessions.messages({ sessionID: chat.id })
        const tool = messages.flatMap((message) => message.parts).find(
          (part): part is CompletedToolPart => part.type === "tool" && part.tool === "read" && part.state.status === "completed",
        )
        expect(tool?.state.output.trimEnd()).toEndWith(`[applies to: models/**] ${fileRule}`)
        const fs = yield* FSUtil.Service
        const usage = JSON.parse((yield* fs.readFileStringSafe(path.join(dir, ".altimate-code/learn/team/usage.json")))!)
        expect(usage).toEqual({ "L-0001": 1, "L-0002": 1, "L-0003": 1 })
      } finally {
        stream.mockRestore()
        registry.mockRestore()
      }
    }),
    { config: { ...cfg, snapshot: false, experimental: { batch_tool: batched }, learn: { capture: false, core_lessons: 1, retrieved_lessons: 1 } } },
    30_000,
  )
}

noLLMServer.instance("learn compaction failure retains the prior section and retries the same summary", () =>
  Effect.gen(function* () {
    const { directory: dir } = yield* TestInstance
    const prior = "## Team rules\nKeep monetary values in integer cents."
    const refreshed = "## Team rules\nVerify currency conversions before rounding."
    yield* writeText(path.join(dir, ".altimate-code/learn/team/approved.json"), "[]")
    yield* writeText(path.join(dir, "notes.txt"), "A harmless file.")
    const section = spyOn(LessonDelivery.prototype, "section").mockResolvedValue(prior)
    const compact = spyOn(LessonDelivery.prototype, "compact").mockResolvedValueOnce(undefined).mockResolvedValue(refreshed)
    const systems: string[][] = []
    const stream = spyOn(LLM, "stream").mockImplementation(async (input) => {
      const step = systems.length
      systems.push([...input.system])
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
      async function* fullStream() {
        yield { type: "start" }
        yield { type: "start-step" }
        if (step === 0) {
          const toolCallId = "compaction-read"
          const args = { filePath: path.join(dir, "notes.txt") }
          yield { type: "tool-input-start", id: toolCallId, toolName: "read" }
          yield { type: "tool-call", toolCallId, toolName: "read", input: args }
          const output = await input.tools.read.execute!(args, { toolCallId, messages: input.messages, abortSignal: input.abort })
          yield { type: "tool-result", toolCallId, toolName: "read", input: args, output }
        } else {
          yield { type: "text-start", id: "reply" }
          yield { type: "text-delta", id: "reply", text: "Done." }
          yield { type: "text-end", id: "reply" }
        }
        yield { type: "finish-step", finishReason: step === 0 ? "tool-calls" : "stop", usage }
        yield { type: "finish", finishReason: step === 0 ? "tool-calls" : "stop", totalUsage: usage }
      }
      return { fullStream: fullStream() } as unknown as Awaited<ReturnType<typeof LLM.stream>>
    })
    try {
      const { prompt, chat, sessions } = yield* boot()
      const seeded = yield* seed(chat.id, { finish: "stop" })
      yield* sessions.updateMessage({ ...seeded.assistant, summary: true })
      const continuation = yield* user(chat.id, "Continue from the summary.")
      const message = (yield* sessions.messages({ sessionID: chat.id })).find((message) => message.info.id === continuation.id)!
      yield* sessions.updatePart({ ...message.parts[0], synthetic: true } as SessionV1.TextPart)
      yield* prompt.loop({ sessionID: chat.id })
      expect(systems).toHaveLength(2)
      expect(systems[0].join("\n")).toContain(prior)
      expect(systems[1].join("\n")).toContain(refreshed)
      expect(compact.mock.calls).toEqual([[chat.id, seeded.user.id], [chat.id, seeded.user.id]])
    } finally {
      stream.mockRestore()
      compact.mockRestore()
      section.mockRestore()
    }
  }),
  { config: { ...cfg, snapshot: false, learn: { capture: false } } },
  30_000,
)

it.instance("learn approved core loads with capture disabled and system stays identical across tool steps", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      learn: { capture: false, core_lessons: 1, retrieved_lessons: 0 },
    }))
    const rule = "Store invoice totals using integer amount_cents values."
    const approvedJson = JSON.stringify([approvedLesson("L-0001", rule, { pinned: true })])
    yield* writeText(path.join(dir, ".altimate-code/learn/team/approved.json"), approvedJson)
    yield* writeText(path.join(dir, "notes.txt"), "A harmless file.")
    const { prompt, chat } = yield* boot()
    yield* llm.tool("read", { filePath: path.join(dir, "notes.txt") })
    yield* llm.text("done")
    yield* prompt.prompt({
      sessionID: chat.id, agent: "build", model: promptRef,
      parts: [{ type: "text", text: "Inspect the project." }],
    })

    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(2)
    expect(systemBytes(inputs[0])).toContain(`## Team rules\\n${rule}`)
    expect(systemBytes(inputs[1])).toBe(systemBytes(inputs[0]))
    expect(systemBytes(inputs[0])).not.toContain("L-0001")
    const fs = yield* FSUtil.Service
    // Delivery counts into git-ignored usage.json and leaves the committed approved.json untouched.
    expect(yield* fs.readFileStringSafe(path.join(dir, ".altimate-code/learn/team/approved.json"))).toBe(approvedJson)
    const usage = yield* Effect.promise(() => LessonStore.readUsage(dir, "team"))
    expect(usage["L-0001"]).toBe(1)
  }),
)

it.instance("learn request additions persist at the user tail once and leave the system unchanged", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      learn: { capture: false, core_lessons: 1, retrieved_lessons: 1 },
    }))
    const core = "Store invoice totals using integer amount_cents values."
    const retrieved = "Validate depreciation schedules against fiscal_year boundaries."
    yield* writeText(path.join(dir, ".altimate-code/learn/team/approved.json"), JSON.stringify([
      approvedLesson("L-0001", core, { pinned: true }),
      approvedLesson("L-0002", retrieved, { tags: ["depreciation"] }),
    ]))
    const { prompt, chat, sessions } = yield* boot()
    yield* llm.text("ready")
    yield* prompt.prompt({
      sessionID: chat.id, agent: "build", model: promptRef,
      parts: [{ type: "text", text: "Hello." }],
    })
    yield* llm.text("checked")
    yield* prompt.prompt({
      sessionID: chat.id, agent: "build", model: promptRef,
      parts: [{ type: "text", text: "Review depreciation schedules." }],
    })

    const firstTwo = yield* llm.inputs
    expect(firstTwo).toHaveLength(2)
    expect(systemBytes(firstTwo[1])).toBe(systemBytes(firstTwo[0]))
    expect(systemBytes(firstTwo[1])).not.toContain(retrieved)
    const tail = requestMessages(firstTwo[1]).at(-1)!
    expect(tail.role).toBe("user")
    expect(requestText(tail.content)).toContain("Review depreciation schedules.")
    expect(requestText(tail.content).trimEnd()).toEndWith(`Team rules for this request:\n${retrieved}`)
    const stored = yield* sessions.messages({ sessionID: chat.id })
    const userTail = stored.findLast((message) => message.info.role === "user")!.parts.at(-1)!
    expect(userTail).toMatchObject({ type: "text", synthetic: true, text: `Team rules for this request:\n${retrieved}` })

    yield* llm.text("checked again")
    yield* prompt.prompt({
      sessionID: chat.id, agent: "build", model: promptRef,
      parts: [{ type: "text", text: "Review depreciation schedules again." }],
    })
    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(3)
    expect(systemBytes(inputs[2])).toBe(systemBytes(inputs[0]))
    expect(requestText(requestMessages(inputs[2]).at(-1)!.content)).not.toContain("Team rules for this request:")
    expect(JSON.stringify(requestMessages(inputs[2])).split("Team rules for this request:")).toHaveLength(2)
  }),
)

it.instance("learn file hooks append glob and anchor matches once and respect the session cap", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      learn: { capture: false, core_lessons: 0, retrieved_lessons: 0, session_max_lessons: 2 },
    }))
    const globRule = "Use explicit source schemas for these model files."
    const anchorRule = "Keep `amount_cents` files in integer monetary units."
    const cappedRule = "Overflow reports require separate verification."
    yield* writeText(path.join(dir, ".altimate-code/learn/team/approved.json"), JSON.stringify([
      approvedLesson("L-0001", globRule, { trigger: { paths: ["models/**"] } }),
      approvedLesson("L-0002", anchorRule),
      approvedLesson("L-0003", cappedRule, { trigger: { paths: ["overflow/**"] } }),
    ]))
    const files = ["models/report.sql", "amount_cents.sql", "overflow/report.sql"].map((file) => path.join(dir, file))
    for (const file of files) yield* writeText(file, "select 1\n")
    const { prompt, chat, sessions } = yield* boot()
    for (const file of [files[0], files[0], files[1], files[2]]) yield* llm.tool("read", { filePath: file })
    yield* llm.text("done")
    yield* prompt.prompt({
      sessionID: chat.id, agent: "build", model: promptRef,
      parts: [{ type: "text", text: "Inspect the project." }],
    })

    const messages = yield* sessions.messages({ sessionID: chat.id })
    const tools = messages.flatMap((message) => message.parts).filter(
      (part): part is CompletedToolPart => part.type === "tool" && part.tool === "read" && part.state.status === "completed",
    )
    expect(tools).toHaveLength(4)
    expect(tools[0].state.output).toContain("Team rules for ")
    expect(tools[0].state.output.trimEnd()).toEndWith(`[applies to: models/**] ${globRule}`)
    expect(tools[1].state.output).not.toContain("Team rules for ")
    expect(tools[2].state.output.trimEnd()).toEndWith(anchorRule)
    expect(tools[3].state.output).not.toContain("Team rules for ")
    const inputs = yield* llm.inputs
    expect(inputs).toHaveLength(5)
    for (const input of inputs) expect(systemBytes(input)).toBe(systemBytes(inputs[0]))
    expect(JSON.stringify(inputs.at(-1))).not.toContain(cappedRule)
  }),
)
// altimate_change end

// Loop semantics

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)
// BUG: REGRESSION: The prompt loop/run-state todo block below still fails when enabled against the v1.17.9
// processor facade. Active runs either fall through to real provider paths or time out before cancellation/busy-state
// cleanup is observable. Minimal src fix: packages/opencode/src/session/prompt.ts must route loop, cancel, shell, and
// child-task execution through the same Effect SessionProcessor/SessionStatus runtime instead of mixed singleton facades.
it.instance("loop surfaces content-filter finishes as session errors", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const errors: NonNullable<SessionV1.Assistant["error"]>[] = []
    const expected = {
      name: "ContentFilterError",
      data: { message: "The response was blocked by the provider's content filter" },
    } satisfies NonNullable<SessionV1.Assistant["error"]>
    const onError = (event: { payload: any }) => {
      if (event.payload?.type !== LegacySession.Event.Error.type) return
      const data = event.payload.properties
      if (data.sessionID === chat.id && data.error) errors.push(data.error)
    }
    GlobalBus.on("event", onError)
    const off = () => GlobalBus.off("event", onError)

    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().text("partial response").contentFilter())

    const result = yield* prompt.loop({ sessionID: chat.id })
    const stored = MessageV2.get({ sessionID: chat.id, messageID: result.info.id })
    off()

    expect(yield* llm.hits).toHaveLength(1)
    expect(result.info.role).toBe("assistant")
    expect(stored.info.role).toBe("assistant")
    if (result.info.role === "assistant" && stored.info.role === "assistant") {
      expect(result.info.finish).toBe("content-filter")
      expect(result.info.error).toEqual(expected as never)
      expect(stored.info.error).toEqual(result.info.error)
      expect(errors).toContainEqual(expected)
    }
    expect(result.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial response" })]),
    )
  }),
)
it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(SessionExecution.noopLayer),
        Effect.provide(SessionV2.defaultLayer),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)
it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("missing-model"),
    })
  }),
)
it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

noLLMServer.instance("prompt tools replace previous prompt tool rules", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt tools" })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { bash: false },
      parts: [{ type: "text", text: "first" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      tools: { read: true },
      parts: [{ type: "text", text: "second" }],
    })

    const reloaded = yield* sessions.get(session.id)
    expect(reloaded.permission).toEqual([{ permission: "read", pattern: "*", action: "allow" }])
    expect(Permission.evaluate("bash", "anything", reloaded.permission ?? []).action).toBe("ask")
  }),
)

// altimate_change start — `reachChildPrompt`: wait for the subtask's own prompt to start before cancelling
const subtaskKeepsMetadata = (reachChildPrompt = false) =>
// altimate_change end
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      // altimate_change start — the task tool publishes this metadata before it calls the child's `prompt()`,
      // where the workspace hook runs. The child's user message is created after that hook, so waiting for
      // it proves the hook ran; the metadata must still be there afterwards.
      if (reachChildPrompt) {
        const child = tool.state.metadata!.sessionId as SessionID
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(child)
            if (msgs.some((item) => item.info.role === "user")) return true
          }),
          "timed out waiting for the subtask's own prompt",
          "20 seconds",
        )
        const after = (yield* MessageV2.filterCompactedEffect(chat.id))
          .find((item) => item.info.role === "assistant" && item.info.agent === "general")
          ?.parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
        expect(after?.state.status).toBe("running")
        if (after?.state.status === "running") expect(after.state.metadata?.sessionId).toBe(child)
      }
      // altimate_change end

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    })

it.instance("running subtask preserves metadata after tool-call transition", subtaskKeepsMetadata, 5_000)

// altimate_change start — the same regression with workspaces ON, the default every signed-in user gets.
// The test preload sets the kill switch for the whole suite, so without these the default branch of the
// workspace skill hook in prompt.ts never ran in CI: it awaits the sync only when a workspace snapshot is
// on disk, and otherwise starts it in the background, and both must leave the turn's ordering intact.
const withWorkspacesOn = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prior = process.env.ALTIMATE_DISABLE_WORKSPACE
      delete process.env.ALTIMATE_DISABLE_WORKSPACE
      return prior
    }),
    () => body,
    (prior) =>
      Effect.sync(() => {
        if (prior === undefined) delete process.env.ALTIMATE_DISABLE_WORKSPACE
        else process.env.ALTIMATE_DISABLE_WORKSPACE = prior
      }),
  )

it.instance(
  "running subtask preserves metadata with workspaces on and no workspace snapshot (sync in the background)",
  () => withWorkspacesOn(subtaskKeepsMetadata(true)),
  30_000,
)

it.instance(
  "running subtask preserves metadata with workspaces on and a workspace snapshot (sync awaited)",
  () => withWorkspacesOn(subtaskKeepsMetadata(true)),
  {
    init: (directory: string) =>
      Effect.sync(() => {
        require("fs").mkdirSync(path.join(directory, ".altimate-code", "skill", "_workspace"), { recursive: true })
      }),
  },
  // Generous: a timed-out test is not interrupted, so it would keep the kill switch cleared for later files.
  30_000,
)

// A one-shot `run` flushes tracked work once, on exit. A background sync that outlasts the turn's wait bound
// must keep the flush waiting until it lands, or the process exits with the sync half-done.
it.instance(
  "a turn's background workspace sync holds the exit flush until it lands, past the turn's wait bound",
  () =>
    withWorkspacesOn(
      Effect.gen(function* () {
        const { llm } = yield* useServerConfig(providerCfg)
        const { prompt, chat } = yield* boot()
        const skillSync = yield* Effect.promise(() => import("../../src/altimate/workspace/skill-sync"))
        let landed = false
        const recent = spyOn(skillSync, "recentlySynced").mockResolvedValue(false)
        const sync = spyOn(skillSync, "syncSkills").mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => {
                landed = true
                resolve({ changed: false, skipped: [] } as unknown as Awaited<ReturnType<typeof skillSync.syncSkills>>)
              }, 2_600),
            ),
        )
        yield* Effect.gen(function* () {
          yield* llm.text("done")
          yield* prompt.prompt({
            sessionID: chat.id, agent: "build", model: promptRef,
            parts: [{ type: "text", text: "Hello." }],
          })
          expect(landed).toBe(false)
          yield* Effect.promise(() => skillSync.flushPendingSyncs(10_000))
          expect(sync).toHaveBeenCalled()
          expect(landed).toBe(true)
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              recent.mockRestore()
              sync.mockRestore()
            }),
          ),
        )
      }),
    ),
  30_000,
)
// altimate_change end
it.instance.todo(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  10_000,
)
it.instance.todo(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics
it.instance.todo(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id)

      yield* llm.hang

      yield* user(chat.id, "more")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
      }
    }),
  3_000,
)
it.instance.todo(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const info = exit.value.info
        if (info.role === "assistant") {
          expect(info.error?.name).toBe("MessageAbortedError")
        }
      }
    }),
  3_000,
)
raceNoLLMServer.instance.todo(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  3_000,
)

// altimate_change start — skip: relies on upstream ToolRegistry.named() live tool map for
// execute() interception. The fork's registry resolves builtin tool definitions freshly on
// each all() call, so patching a returned tool does not affect the instance the prompt loop
// runs, making this interception-based test inapplicable to the fork's architecture.
noLLMServer.instance.skip(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      // Skipped test: fork Tool.Info exposes no live execute() to patch (see skip note above).
      const task = (yield* registry.allInfos()).find((tool) => tool.id === "task")! as any
      const original = task.execute
      task.execute = (_args: any, ctx: any) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)
// altimate_change end
it.instance.todo(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)
it.instance.todo(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  3_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance(
  "concurrent loop callers all receive same error result",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.fail("boom")
      yield* user(chat.id, "hello")

      const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
        concurrency: "unbounded",
      })
      expect(a.info.id).toBe(b.info.id)
      expect(a.info.role).toBe("assistant")
    }),
  3_000,
)
it.instance.todo(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.hold("first", deferredAsPromise(gate))
      yield* llm.text("second")

      const a = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: promptRef,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)

      const id = MessageID.ascending()
      const b = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: id,
          agent: "build",
          model: promptRef,
          parts: [{ type: "text", text: "second" }],
        })
        .pipe(Effect.forkChild)

      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined,
            ),
          ),
        "timed out waiting for second prompt to save",
      )

      yield* Deferred.succeed(gate, void 0)

      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const assistants = msgs.filter((msg) => msg.info.role === "assistant")
      expect(assistants).toHaveLength(2)
      const last = assistants.at(-1)
      if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
      expect(last.info.parentID).toBe(id)
      expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      const messages = inputs.at(-1)?.messages
      if (!Array.isArray(messages)) throw new Error("expected LLM messages")
      expect(messages.at(-1)).toEqual({ role: "user", content: "second" })
    }),
  3_000,
)
it.instance.todo(
  "assertNotBusy fails with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  3_000,
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics
it.instance.todo(
  "shell rejects with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  3_000,
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)
it.instance.todo(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  3_000,
)
it.instance.todo(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  3_000,
)
it.instance(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)
noLLMServer.instance.todo(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)
it.instance.todo(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        description: "Print many lines",
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)
noLLMServer.instance.todo(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)
noLLMServer.instance.todo(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

// altimate_change start — skip: relies on upstream ToolRegistry.named() live tool map for
// execute() interception; the fork resolves builtin tool definitions freshly per all() call so
// the patched instance is not the one the prompt loop runs (see "cancel finalizes subtask tool
// state" above for the same architectural mismatch).
noLLMServer.instance.skip(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const read = (yield* registry.allInfos()).find((tool) => tool.id === "read")! as any
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance.skip(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const read = (yield* registry.allInfos()).find((tool) => tool.id === "read")! as any
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)
// altimate_change end

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* Effect.promise(() => SessionPrompt.resolvePromptParts("Read @file#name.txt"))
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)
it.instance.todo(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Prompt cancel regression" })

      yield* llm.hang

      const fiber = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "Cancel me" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* prompt.cancel(session.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        if (exit.value.info.role === "assistant") {
          expect(exit.value.info.error?.name).toBe("MessageAbortedError")
        }
      }

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const last = msgs.findLast((msg) => msg.info.role === "assistant")
      expect(last?.info.role).toBe("assistant")
      if (last?.info.role === "assistant") {
        expect(last.info.error?.name).toBe("MessageAbortedError")
      }
    }),
  3_000,
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)
