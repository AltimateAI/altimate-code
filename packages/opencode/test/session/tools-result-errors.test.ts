// altimate_change start — failed backend results must reject at the SDK tool boundary
import { expect, spyOn } from "bun:test"
import { streamText } from "ai"
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { ProjectID } from "@/project/schema"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { SessionPrompt } from "@/session/prompt"
import * as Precedence from "@/altimate/workspace/precedence"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID: ProviderID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    interleaved: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128000, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: Permission.fromConfig({ "*": "allow" }),
}
const failure = 'Failed to execute SQL: Error: Parser Error: syntax error at or near "nulls"'
const it = testEffect(
  Layer.mergeAll(
    Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
    Layer.mock(Permission.Service, {}),
    Layer.mock(MCP.Service, { tools: () => Effect.succeed({}) }),
    Layer.mock(Truncate.Service, {}),
    Layer.mock(ToolRegistry.Service, {
      tools: () =>
        Effect.succeed([
          {
            id: "backend_failure",
            description: "Return a backend failure",
            parameters: Schema.Struct({}),
            registrySource: undefined,
            execute: () =>
              Effect.succeed({
                title: "SQL: ERROR",
                output: failure,
                status: "error" as const,
                metadata: { success: false, error: failure },
              }),
          },
        ]),
    }),
  ),
)

for (const aborted of [false, true]) {
  it.live(
    aborted
      ? "session/tools completes aborted error envelopes before rejecting at the SDK boundary"
      : "session/tools rejects backend error envelopes at the SDK boundary",
    () =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("ses_tools_errors")
        const messageID = MessageID.make("msg_tools_errors")
        const completed: Array<{ callID: string; result: unknown }> = []
        const tools = yield* SessionTools.resolve({
          agent,
          model,
          bypassAgentCheck: false,
          messages: [],
          session: {
            id: sessionID,
            slug: "tools-errors",
            projectID: ProjectV2.ID.make("project"),
            directory: "/tmp",
            title: "Tool errors",
            version: "1",
            time: { created: 0, updated: 0 },
          },
          processor: {
            message: {
              id: messageID,
              sessionID,
              role: "assistant",
              time: { created: 0 },
              parentID: MessageID.make("msg_user"),
              modelID: model.id,
              providerID: model.providerID,
              mode: "build",
              agent: "build",
              path: { cwd: "/tmp", root: "/tmp" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            updateToolCall: () => Effect.succeed(undefined),
            completeToolCall: (callID, result) =>
              Effect.sync(() => {
                completed.push({ callID, result })
              }),
          },
          promptOps: {
            resolvePromptParts: () => Effect.succeed([]),
            prompt: () => Effect.die("unexpected prompt"),
            cancel: () => Effect.void,
          },
        })
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            tools.backend_failure.execute!(
              {},
              {
                toolCallId: "call_error",
                messages: [],
                abortSignal: aborted ? AbortSignal.abort() : AbortSignal.any([]),
              },
            ),
          ),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(failure)
        expect(completed).toEqual(
          aborted
            ? [
                {
                  callID: "call_error",
                  result: expect.objectContaining({ output: failure, status: "error" }),
                },
              ]
            : [],
        )
      }),
  )
}

it.live("session/prompt resolveTools emits an SDK tool-error for a backend error envelope", () =>
  Effect.gen(function* () {
    const sessionID = SessionID.make("ses_prompt_tools_errors")
    const finished: unknown[] = []
    const registry = spyOn(ToolRegistry, "tools").mockResolvedValue([
      {
        id: "backend_failure",
        description: "Return a backend failure",
        parameters: Schema.Struct({}),
        registrySource: undefined,
        execute: () =>
          Effect.succeed({
            title: "SQL: ERROR",
            output: failure,
            status: "error" as const,
            metadata: { success: false, error: failure },
          }),
      },
    ])
    const mcp = spyOn(MCP, "tools").mockResolvedValue({})
    const plugins = spyOn(Plugin, "trigger").mockImplementation(async (_name, _input, output) => output)
    const precedence = spyOn(Precedence, "refresh").mockResolvedValue({
      enabled: false,
      workspaceName: "",
      shadowed: new Map(),
    })
    try {
      const tools = yield* Effect.promise(() =>
        SessionPrompt.resolveTools({
          agent,
          model,
          bypassAgentCheck: false,
          messages: [],
          session: {
            id: sessionID,
            slug: "prompt-tools-errors",
            projectID: ProjectID.make("project"),
            directory: "/tmp",
            title: "Prompt tool errors",
            version: "1",
            time: { created: 0, updated: 0 },
          },
          processor: {
            message: {
              id: MessageID.make("msg_prompt_tools_errors"),
              sessionID,
              role: "assistant",
              time: { created: 0 },
              parentID: MessageID.make("msg_user"),
              modelID: model.id,
              providerID: model.providerID,
              mode: "build",
              agent: "build",
              path: { cwd: "/tmp", root: "/tmp" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            beginToolExecution: (raw) => ({ raw, occurrence: 0 }),
            finishToolExecution: (execution) => {
              finished.push(execution)
            },
            partFromToolExecution: () => undefined,
            partFromToolCall: () => undefined,
            process: async () => {
              throw new Error("unexpected processor invocation")
            },
          },
        }),
      )
      const stream = streamText({
        model: new MockLanguageModelV3({
          doStream: async () => ({
            stream: convertArrayToReadableStream([
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "call_error", toolName: "backend_failure", input: "{}" },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ]),
          }),
        }),
        prompt: "Run the query",
        tools,
      })
      const events = yield* Effect.promise(() => Array.fromAsync(stream.fullStream))
      expect(events.filter((event) => event.type === "tool-error")).toEqual([
        expect.objectContaining({
          toolCallId: "call_error",
          toolName: "backend_failure",
          error: expect.objectContaining({ message: failure }),
        }),
      ])
      expect(events.some((event) => event.type === "tool-result")).toBe(false)
      expect(finished).toEqual([{ raw: "call_error", occurrence: 0 }])
    } finally {
      precedence.mockRestore()
      plugins.mockRestore()
      mcp.mockRestore()
      registry.mockRestore()
    }
  }),
)
// altimate_change end
