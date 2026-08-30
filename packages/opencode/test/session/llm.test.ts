import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { jsonSchema, tool, type ModelMessage } from "ai"
import { LLM } from "../../src/session/llm"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { ModelsDev } from "../../src/provider/models"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"

describe("session.llm.toolNamesFromMessages", () => {
  test("returns empty set for empty messages", () => {
    expect(LLM.toolNamesFromMessages([])).toEqual(new Set())
  })

  test("returns empty set for messages with no tool calls", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ]
    expect(LLM.toolNamesFromMessages(messages)).toEqual(new Set())
  })

  test("extracts tool names from tool-call blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "bash" },
          { type: "tool-call", toolCallId: "call-2", toolName: "read" },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.toolNamesFromMessages(messages)).toEqual(new Set(["bash", "read"]))
  })

  test("deduplicates tool names across messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "bash" }],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-2", toolName: "bash" }],
      },
    ] as ModelMessage[]
    expect(LLM.toolNamesFromMessages(messages)).toEqual(new Set(["bash"]))
  })

  test("extracts tool names from tool-result blocks", () => {
    const messages = [
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-1", toolName: "bash" }],
      },
    ] as ModelMessage[]
    expect(LLM.toolNamesFromMessages(messages)).toEqual(new Set(["bash"]))
  })

  test("extracts from both tool-call and tool-result blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "bash" }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-1", toolName: "bash" }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-2", toolName: "read" }],
      },
    ] as ModelMessage[]
    expect(LLM.toolNamesFromMessages(messages)).toEqual(new Set(["bash", "read"]))
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

type Pending = { path: string; response: Response; resolve: (value: Capture) => void; reject: (e: unknown) => void }

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  // Map<pathSuffix, Pending>. Path-keyed (was a FIFO queue) so a slow OpenAI
  // request can't resolve a faster Gemini deferred — that cascade was the
  // failure mode under heavy parallel-suite load (test 3 timed out at 5s,
  // its in-flight request landed in test 4's queue, test 4 saw "/v1/responses"
  // instead of "/v1beta/...:streamGenerateContent").
  pending: new Map<string, Pending>(),
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void; reject: (e: unknown) => void }
  result.promise = new Promise((resolve, reject) => {
    result.resolve = resolve
    result.reject = reject
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.pending.set(pathname, { path: pathname, response, resolve: pending.resolve, reject: pending.reject })
  return pending.promise
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      // Find the pending entry whose registered suffix matches this request's path.
      // Last-suffix-wins for unlikely overlapping registrations (none today).
      let matchedKey: string | undefined
      for (const key of state.pending.keys()) {
        if (url.pathname.endsWith(key)) matchedKey = key
      }
      if (!matchedKey) {
        return new Response(`unexpected request: ${url.pathname}`, { status: 500 })
      }
      const next = state.pending.get(matchedKey)!
      state.pending.delete(matchedKey)

      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })
      return next.response
    },
  })
})

beforeEach(() => {
  // Reject any leftover deferreds before clearing — otherwise an awaiting test
  // would hang for the full timeout. Always-resolved capture means the next
  // test sees real path mismatch errors rather than a corrupted Capture.
  for (const pending of state.pending.values()) {
    pending.reject(new Error("test cleanup: pending request never received"))
  }
  state.pending.clear()
})

afterAll(() => {
  state.server?.stop()
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, ModelsDev.Provider>>(fixturePath)
  const provider = data[providerID]
  if (!provider) {
    throw new Error(`Missing provider in fixture: ${providerID}`)
  }
  const model = provider.models[modelID]
  if (!model) {
    throw new Error(`Missing model in fixture: ${modelID}`)
  }
  return { provider, model }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("session.llm.stream", () => {
  test.skip("sends temperature, tokens, and reasoning options for openai-compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://altimate.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          variant: "high",
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      },
    })
  })

  test("sends responses API payload for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model

    const responseChunks = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-1",
        delta: "Hello",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(responseChunks, true))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://altimate.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user_2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id },
          variant: "high",
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")

        // altimate_change start — upstream PR #21225 moved the codex/copilot maxOutputTokens
        // exclusion from session/llm.ts to the codex plugin chat.params hook. The hook applies
        // to ALL `provider === "openai"` models (matches codex cli behavior), so the OpenAI
        // /responses payload omits max_output_tokens. Our prior assertion expected the
        // ProviderTransform value; align with upstream's "undefined → match codex cli" expectation.
        const maxTokens = body.max_output_tokens as number | undefined
        expect(maxTokens).toBe(undefined)
        // altimate_change end
      },
    })
  }, 30_000)

  test.skip("sends messages API payload for Anthropic models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "anthropic"
    const modelID = "claude-3-5-sonnet-20241022"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model

    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://altimate.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      },
    })
  })

  test("sends Google API payload for Gemini models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const provider = fixture.provider
    const model = fixture.model
    const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      },
    ]
    const request = waitRequest(pathSuffix, createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://altimate.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-google-key",
                  baseURL: `${server.url.origin}/v1beta`,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user_4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      },
    })
  }, 30_000)

  test("clamps finalized tools and reasoning in the Google stream request", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const pathSuffix = `/v1beta/models/${fixture.model.id}:streamGenerateContent`
    const request = waitRequest(
      pathSuffix,
      createEventResponse([
        {
          candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        },
      ]),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://altimate.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-google-key",
                  baseURL: `${server.url.origin}/v1beta`,
                  headers: { "Anthropic-Beta": "context-1m-2025-08-07" },
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(fixture.model.id))
        const budgeted = {
          ...resolved,
          headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" },
          limit: { ...resolved.limit, context: 65_536, output: 16_384 },
        }
        const sessionID = SessionID.make("session-budget-stream")
        const agent = {
          name: "test",
          mode: "primary",
          options: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16_000 } },
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user_budget_stream"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: budgeted.id },
        } satisfies MessageV2.User
        const prose = "the quick brown fox jumps over the lazy dog "
        const largeSystem = prose.repeat(Math.ceil((45_000 * 3.7) / prose.length))
        const schemaMarker = "finalized-tool-schema-marker"
        const tools = {
          schema_heavy: tool({
            description: `${schemaMarker} ${"search parameter documentation ".repeat(1_000)}`,
            inputSchema: jsonSchema({
              type: "object",
              properties: {
                query: { type: "string", description: "query details ".repeat(1_000) },
              },
              required: ["query"],
            }),
          }),
        }

        const stream = await LLM.stream({
          user,
          sessionID,
          model: budgeted,
          agent,
          system: [largeSystem],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools,
        })
        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const config = capture.body.generationConfig as
          | { maxOutputTokens?: number; thinkingConfig?: { thinkingBudget?: number } }
          | undefined
        const maxOutputTokens = config?.maxOutputTokens
        expect(maxOutputTokens).toBeDefined()
        expect(maxOutputTokens!).toBeLessThan(16_384)
        expect(maxOutputTokens!).toBeGreaterThanOrEqual(1_024)
        expect(config?.thinkingConfig?.thinkingBudget).toBe(maxOutputTokens! - 1_024)
        expect(JSON.stringify(capture.body.tools)).toContain(schemaMarker)
        expect(capture.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14")
      },
    })
  }, 30_000)

  test("normalizes unsupported media before the Google stream budget is enforced", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const pathSuffix = `/v1beta/models/${fixture.model.id}:streamGenerateContent`
    const request = waitRequest(
      pathSuffix,
      createEventResponse([
        {
          candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        },
      ]),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://altimate.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: { apiKey: "test-google-key", baseURL: `${server.url.origin}/v1beta` },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await Provider.getModel(ProviderID.make(providerID), ModelID.make(fixture.model.id))
        const textOnly = {
          ...resolved,
          capabilities: {
            ...resolved.capabilities,
            input: { ...resolved.capabilities.input, image: false },
          },
          limit: { ...resolved.limit, context: 65_536, output: 16_384 },
        }
        const sessionID = SessionID.make("session-budget-unsupported-media")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user_budget_unsupported_media"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: textOnly.id },
        } satisfies MessageV2.User

        const stream = await LLM.stream({
          user,
          sessionID,
          model: textOnly,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [
            {
              role: "user",
              content: Array.from({ length: 64 }, () => ({
                type: "image" as const,
                image: "data:image/png;base64,AQ==",
              })),
            },
          ],
          tools: {},
        })
        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const config = capture.body.generationConfig as { maxOutputTokens?: number } | undefined
        expect(config?.maxOutputTokens).toBe(16_384)
        expect(JSON.stringify(capture.body.contents)).toContain("Cannot read image")
      },
    })
  }, 30_000)
})
