import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { LLM } from "../../src/session/llm"
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
import { FreeTier } from "../../src/altimate/free/client"

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

// altimate_change start — managed session header must never leak to third-party providers
describe("session.llm.withManagedSessionHeaders", () => {
  test("the managed session ID wins over plugin headers without changing other providers", () => {
    const sessionID = SessionID.make("ses_trusted-session")
    const pluginHeaders = {
      "X-Session-Id": "plugin-controlled",
      "x-session-id": "plugin-controlled-lowercase",
      "X-Plugin": "preserved",
    }
    expect(LLM.withManagedSessionHeaders("altimate-free", sessionID, pluginHeaders)).toEqual({
      "X-Session-Id": sessionID,
      "X-Plugin": "preserved",
    })
    expect(LLM.withManagedSessionHeaders("anthropic", sessionID, pluginHeaders)).toEqual(pluginHeaders)
  })
})
// altimate_change end

// Harness reliability / item 3: stub injection must be skipped entirely when the call
// exposes zero real tools AND uses the explicit toolChoice "none" no-tool-call
// contract (e.g. the compaction summarizer) — the provider-compat fallback path.
// A normal turn that happens to have zero real tools (allowlist/permissions
// stripped everything) must still get historical stubs so referenced tool_use
// blocks in history don't trip provider validation.
describe("session.llm.addHistoricalToolStubs", () => {
  test("skips stub injection when there are zero real tools AND toolChoice is none", () => {
    const tools: Record<string, Tool> = {}
    const result = LLM.addHistoricalToolStubs(tools, new Set(["bash", "read"]), "none")
    expect(result).toBe(tools)
    expect(Object.keys(tools)).toEqual([])
  })

  test("still injects stubs for zero real tools when toolChoice is not none", () => {
    const tools: Record<string, Tool> = {}
    LLM.addHistoricalToolStubs(tools, new Set(["bash", "read"]))
    expect(Object.keys(tools).sort()).toEqual(["bash", "read"])
  })

  test("injects stubs for referenced tools missing from a non-empty tool set", () => {
    const real = { description: "real bash" } as Tool
    const tools: Record<string, Tool> = { bash: real }
    LLM.addHistoricalToolStubs(tools, new Set(["bash", "old_mcp_tool"]))
    expect(Object.keys(tools).sort()).toEqual(["bash", "old_mcp_tool"])
    // Existing real tools are never overwritten.
    expect(tools.bash).toBe(real)
    expect(tools.old_mcp_tool.description).toContain("[Historical]")
  })

  test("is a no-op when every referenced tool already has a definition", () => {
    const real = { description: "real bash" } as Tool
    const tools: Record<string, Tool> = { bash: real }
    LLM.addHistoricalToolStubs(tools, new Set(["bash"]))
    expect(Object.keys(tools)).toEqual(["bash"])
    expect(tools.bash).toBe(real)
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
        expect(headers.get("X-Session-Id")).toBeNull()

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

// altimate_change start — routing hint (Phase 0): verifies the outgoing chat.completions body
// carries `metadata.altimate` for the Altimate-managed providers, end-to-end through
// ProviderTransform.options()/providerOptions() and the real @ai-sdk/openai-compatible request
// serialization (see docs/internal/2026-09-22-gateway-model-routing-research.md, client section).
// Uses "altimate-backend" (not "altimate-free") because the free-tier provider is deliberately
// excluded from config-based registration (`Provider.ts`'s `configProviders` filter) — the
// managed-consent gate that "altimate-backend" doesn't have — so it's the one Altimate-managed
// provider a test can point at a local server via plain `opencode.json` config, exactly like the
// "sends responses API payload for OpenAI models" test above does for "openai". The metadata
// injection itself is provider-ID gated (`ProviderTransform.isAltimateManagedProviderID`), so
// what's exercised here — the body actually carrying `metadata.altimate` — is identical for
// "altimate-free".
describe("session.llm.stream - altimate routing hint (Phase 0)", () => {
  test("sends metadata.altimate with task_kind/agent/tools/session_pos/message_id", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

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
            provider: {
              "altimate-backend": {
                options: {
                  baseURL: `${server.url.origin}/agents/v1`,
                  apiKey: "test-altimate-backend-key",
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
        const resolved = await Provider.getModel(ProviderID.make("altimate-backend"), ModelID.make("altimate-default"))
        const sessionID = SessionID.make("session-test-altimate-hint")
        const agent = {
          name: "build",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user_hint_1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("altimate-backend"), modelID: resolved.id },
        } satisfies MessageV2.User

        const oneTool: Record<string, Tool> = {
          bash: tool({
            description: "run a shell command",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
          }),
        }

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: oneTool,
          taskKind: "review",
          // altimate_change — routing hint (Phase 0): callers with no processor turn (this test
          // stands in for one) set this explicitly; processor.ts sets it automatically for
          // main/subagent/summary/compaction turns (see processor-effect.test.ts).
          messageId: "msg_user_hint_1",
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const metadata = capture.body.metadata as Record<string, unknown> | undefined
        const altimate = metadata?.altimate as Record<string, unknown> | undefined
        expect(altimate).toBeDefined()
        expect(altimate?.task_kind).toBe("review")
        expect(altimate?.agent).toBe("build")
        expect(altimate?.tools).toBe(1)
        expect(altimate?.session_pos).toBe(1)
        expect(altimate?.message_id).toBe("msg_user_hint_1")
      },
    })
  }, 30_000)

  test("defaults task_kind to 'other' when the call site doesn't stamp one", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

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
            provider: {
              "altimate-backend": {
                options: {
                  baseURL: `${server.url.origin}/agents/v1`,
                  apiKey: "test-altimate-backend-key",
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
        const resolved = await Provider.getModel(ProviderID.make("altimate-backend"), ModelID.make("altimate-default"))
        const sessionID = SessionID.make("session-test-altimate-hint-default")
        const agent = {
          name: "build",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user_hint_2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("altimate-backend"), modelID: resolved.id },
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
          // no taskKind — must default to "other", never crash or omit metadata
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const metadata = capture.body.metadata as Record<string, unknown> | undefined
        const altimate = metadata?.altimate as Record<string, unknown> | undefined
        expect(altimate?.task_kind).toBe("other")
        // altimate_change — routing hint (Phase 0): no `messageId` set on this call (mirrors
        // skill-selector/enhance-prompt/ai-review/project-copy, which have no message to be
        // "about") — `message_id` must be omitted entirely, never a throwaway synthetic id.
        expect(altimate).not.toHaveProperty("message_id")
      },
    })
  }, 30_000)

  test("clamps tools to 512 and drops an invalid agent name", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

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
            provider: {
              "altimate-backend": {
                options: {
                  baseURL: `${server.url.origin}/agents/v1`,
                  apiKey: "test-altimate-backend-key",
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
        const resolved = await Provider.getModel(ProviderID.make("altimate-backend"), ModelID.make("altimate-default"))
        const sessionID = SessionID.make("session-test-altimate-hint-clamp")
        // "Custom Agent!" fails the gateway's ^[a-z][a-z0-9_-]{0,31}$ allowlist (uppercase, a
        // space, punctuation) — the client must drop the key, not send it and let the gateway
        // silently drop it server-side.
        const agent = {
          name: "Custom Agent!",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user_hint_clamp"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("altimate-backend"), modelID: resolved.id },
        } satisfies MessageV2.User

        // 600 tools declared — over the gateway's 512 cap.
        const manyTools: Record<string, Tool> = Object.fromEntries(
          Array.from({ length: 600 }, (_, i) => [
            `tool_${i}`,
            tool({ description: "test", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
          ]),
        )

        const stream = await LLM.stream({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "Hello" }],
          tools: manyTools,
          taskKind: "main",
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        const metadata = capture.body.metadata as Record<string, unknown> | undefined
        const altimate = metadata?.altimate as Record<string, unknown> | undefined
        expect(altimate?.tools).toBe(512)
        expect(altimate).not.toHaveProperty("agent")
      },
    })
  }, 30_000)

  // altimate_change start — routing hint (Phase 0): title/enhance-prompt/project-copy all call
  // LLM.stream with `small: true` and no tools, and (unlike the tests above, which use
  // "altimate-backend" for config-registration convenience) they run against the real
  // "altimate-free" provider in production. Covers both gaps at once: the `small: true` path
  // (ProviderTransform.smallOptions(), not .options() — the reason the hint is injected in
  // stream() rather than inside options(), see the comment there) and the free-tier provider.
  test("attaches metadata.altimate on the small:true altimate-free path (title/enhance/project-copy shape)", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const credentials = spyOn(FreeTier, "credentialsForLoad").mockResolvedValue({
      apiKey: "sk-altimate-base-fake",
      baseURL: server.url.origin,
      installSecret: "install-secret",
    })

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Untitled Session"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    try {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const resolved = await Provider.getModel(ProviderID.make(FreeTier.PROVIDER_ID), ModelID.make(FreeTier.MODEL_ID))
          const sessionID = SessionID.make("session-test-altimate-free-small")
          const agent = {
            name: "title",
            mode: "primary",
            hidden: true,
            options: {},
            permission: [],
          } satisfies Agent.Info

          const user = {
            id: MessageID.make("msg_user_free_small"),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: agent.name,
            model: { providerID: ProviderID.make(FreeTier.PROVIDER_ID), modelID: resolved.id },
          } satisfies MessageV2.User

          const stream = await LLM.stream({
            user,
            sessionID,
            model: resolved,
            agent,
            system: [],
            small: true,
            tools: {},
            toolChoice: "none",
            abort: new AbortController().signal,
            messages: [{ role: "user", content: "Generate a title for this conversation:\n" }],
            taskKind: "title",
            messageId: "msg_user_free_small",
          })

          for await (const _ of stream.fullStream) {
          }

          const capture = await request
          const metadata = capture.body.metadata as Record<string, unknown> | undefined
          const altimate = metadata?.altimate as Record<string, unknown> | undefined
          expect(altimate).toBeDefined()
          expect(altimate?.task_kind).toBe("title")
          expect(altimate?.agent).toBe("title")
          expect(altimate?.tools).toBe(0)
          expect(altimate?.message_id).toBe("msg_user_free_small")
        },
      })
    } finally {
      credentials.mockRestore()
    }
  }, 30_000)
  // altimate_change end

  test("does not attach metadata.altimate for non-Altimate providers", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("alibaba", "qwen-plus")
    const model = source.model

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
            enabled_providers: ["alibaba"],
            provider: {
              alibaba: {
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
        const resolved = await Provider.getModel(ProviderID.make("alibaba"), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-non-altimate-hint")
        const agent = {
          name: "build",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user_hint_3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("alibaba"), modelID: resolved.id },
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
          taskKind: "review",
        })

        for await (const _ of stream.fullStream) {
        }

        const capture = await request
        expect(capture.body.metadata).toBeUndefined()
      },
    })
  }, 30_000)
})
// altimate_change end
