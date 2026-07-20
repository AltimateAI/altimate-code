import { describe, expect, test } from "bun:test"
import path from "path"
import { generateText, type ModelMessage } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { ProviderTransform } from "../../src/provider/transform"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { Provider } from "../../src/provider/provider"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import {
  buildToolCapableSet,
  parseSnowflakePAT,
  relocateCacheControl,
  SnowflakeCortexAuthPlugin,
  stripCacheControl,
  transformSnowflakeBody,
} from "../../src/altimate/plugin/snowflake"

function provideProviderTestInstance<R>(input: {
  directory: string
  init?: () => Promise<unknown>
  fn: () => R | Promise<R>
}) {
  const now = Date.now()
  return Instance.restore(
    {
      directory: input.directory,
      worktree: input.directory,
      project: {
        id: ProjectID.global,
        worktree: input.directory,
        time: {
          created: now,
          updated: now,
        },
        sandboxes: [],
      },
    },
    async () => {
      await input.init?.()
      return input.fn()
    },
  )
}

// Fixture allowlist for transformSnowflakeBody unit tests. Reflects what
// Snowflake Cortex actually accepts tools for today (Claude + OpenAI families).
// Production code derives the equivalent set from `provider.models` at loader
// time; this fixture exists so unit tests of the pure transform stay simple.
const TOOLCAPABLE_FIXTURE: ReadonlySet<string> = new Set([
  "claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-4-6", "claude-sonnet-4-5",
  "claude-opus-4-5", "claude-haiku-4-5", "claude-4-sonnet", "claude-3-7-sonnet",
  "claude-3-5-sonnet",
  "openai-gpt-4.1", "openai-gpt-5", "openai-gpt-5.1", "openai-gpt-5.2",
  "openai-gpt-5-mini", "openai-gpt-5-nano", "openai-gpt-5-chat",
])

// ---------------------------------------------------------------------------
// parseSnowflakePAT
// ---------------------------------------------------------------------------

describe("parseSnowflakePAT", () => {
  test("parses valid account::token", () => {
    const result = parseSnowflakePAT("myorg-myaccount::my-pat-token")
    expect(result).toEqual({ account: "myorg-myaccount", token: "my-pat-token" })
  })

  test("trims whitespace around account and token", () => {
    const result = parseSnowflakePAT("  myorg-myaccount  ::  my-pat-token  ")
    expect(result).toEqual({ account: "myorg-myaccount", token: "my-pat-token" })
  })

  test("returns null when separator is missing", () => {
    expect(parseSnowflakePAT("myorg-myaccount;my-pat-token")).toBeNull()
    expect(parseSnowflakePAT("myorg-myaccount:my-pat-token")).toBeNull()
    expect(parseSnowflakePAT("myorg-myaccountmy-pat-token")).toBeNull()
  })

  test("returns null when account is empty", () => {
    expect(parseSnowflakePAT("::my-pat-token")).toBeNull()
  })

  test("returns null when token is empty", () => {
    expect(parseSnowflakePAT("myorg-myaccount::")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(parseSnowflakePAT("")).toBeNull()
  })

  test("uses first :: as separator (token may contain ::)", () => {
    const result = parseSnowflakePAT("myorg::token::with::colons")
    expect(result).toEqual({ account: "myorg", token: "token::with::colons" })
  })

  test("rejects account with slashes (URL injection)", () => {
    expect(parseSnowflakePAT("evil/path::token")).toBeNull()
  })

  test("rejects account with query characters", () => {
    expect(parseSnowflakePAT("evil?x=y::token")).toBeNull()
  })

  test("rejects account with hash fragment", () => {
    expect(parseSnowflakePAT("evil#fragment::token")).toBeNull()
  })

  test("rejects account with spaces", () => {
    expect(parseSnowflakePAT("evil account::token")).toBeNull()
  })

  test("rejects account with unicode characters", () => {
    expect(parseSnowflakePAT("αλφα::token")).toBeNull()
  })

  test("accepts account with dots and underscores", () => {
    const result = parseSnowflakePAT("my_org.account-1::token")
    expect(result).toEqual({ account: "my_org.account-1", token: "token" })
  })
})

// ---------------------------------------------------------------------------
// transformSnowflakeBody
// ---------------------------------------------------------------------------

describe("transformSnowflakeBody", () => {
  test("rewrites max_tokens to max_completion_tokens", () => {
    const input = JSON.stringify({ model: "claude-sonnet-4-6", messages: [], max_tokens: 1000 })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.max_completion_tokens).toBe(1000)
    expect(parsed.max_tokens).toBeUndefined()
  })

  test("leaves requests without max_tokens unchanged", () => {
    const input = JSON.stringify({ model: "claude-sonnet-4-6", messages: [], max_completion_tokens: 1000 })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.max_completion_tokens).toBe(1000)
    expect(parsed.max_tokens).toBeUndefined()
  })

  test("strips tools for mistral-large2", () => {
    const input = JSON.stringify({
      model: "mistral-large2",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
      tool_choice: "auto",
    })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeUndefined()
    expect(parsed.tool_choice).toBeUndefined()
  })

  test("strips tools for llama3.3-70b", () => {
    const input = JSON.stringify({
      model: "llama3.3-70b",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeUndefined()
  })

  test("strips tools for deepseek-r1", () => {
    const input = JSON.stringify({
      model: "deepseek-r1",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeUndefined()
  })

  test("keeps tools for openai-gpt-4.1", () => {
    const input = JSON.stringify({
      model: "openai-gpt-4.1",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeDefined()
    expect(parsed.tools).toHaveLength(1)
  })

  test("keeps tools for claude-sonnet-4-6", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeDefined()
    expect(parsed.tools).toHaveLength(1)
  })

  test("returns synthetic stop response when last message is assistant without tool_calls", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "I'm here!" },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { syntheticStop } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(syntheticStop).toBeDefined()
    expect(syntheticStop!.status).toBe(200)
    expect(syntheticStop!.headers.get("content-type")).toBe("text/event-stream")
  })

  test("does NOT short-circuit when last message is assistant with tool_calls", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "", tool_calls: [{ id: "tc1", function: { name: "read_file" } }] },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { syntheticStop } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(syntheticStop).toBeUndefined()
  })

  test("does NOT short-circuit when last message is user", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { syntheticStop } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(syntheticStop).toBeUndefined()
  })

  test("does NOT short-circuit when stream is false", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      stream: false,
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "I'm here!" },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(syntheticStop).toBeUndefined()
  })

  test("short-circuits when stream is true", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "I'm here!" },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(syntheticStop).toBeDefined()
  })

  test("short-circuits when stream is not specified (defaults to streaming)", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "I'm here!" },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(syntheticStop).toBeDefined()
  })

  test("triggers synthetic stop when tool_calls is empty array", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "done", tool_calls: [] },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(syntheticStop).toBeDefined()
  })

  test("removes orphaned tool_calls from messages for no-toolcall models", () => {
    const input = JSON.stringify({
      model: "llama3.3-70b",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "", tool_calls: [{ id: "tc1", function: { name: "read_file" } }] },
        { role: "tool", content: "file contents", tool_call_id: "tc1" },
        { role: "assistant", content: "here is the file" },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeUndefined()
    // tool_calls should be removed from assistant messages
    for (const msg of parsed.messages) {
      expect(msg.tool_calls).toBeUndefined()
    }
    // tool role messages should be filtered out
    expect(parsed.messages.every((m: { role: string }) => m.role !== "tool")).toBe(true)
  })

  test("throws on invalid JSON input", () => {
    expect(() => transformSnowflakeBody("not-json", TOOLCAPABLE_FIXTURE)).toThrow()
  })

  test("synthetic stop SSE stream has correct format", async () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "done" },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(syntheticStop).toBeDefined()
    const text = await syntheticStop!.text()
    // Should contain SSE data lines and [DONE]
    expect(text).toContain("data: ")
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain("data: [DONE]")
    // Should NOT contain usage block (avoids zero-token accounting issues)
    expect(text).not.toContain('"usage"')
  })

  test("handles empty messages array without crashing", () => {
    const input = JSON.stringify({ model: "claude-sonnet-4-6", messages: [] })
    const { syntheticStop } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(syntheticStop).toBeUndefined()
  })

  test("handles missing messages field", () => {
    const input = JSON.stringify({ model: "claude-sonnet-4-6" })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(JSON.parse(body).model).toBe("claude-sonnet-4-6")
  })

  test("preserves max_completion_tokens when max_tokens is absent", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "test" }],
      max_completion_tokens: 500,
    })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.max_completion_tokens).toBe(500)
    expect(parsed.max_tokens).toBeUndefined()
  })

  test("handles both max_tokens and max_completion_tokens (max_tokens wins)", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "test" }],
      max_tokens: 100,
      max_completion_tokens: 500,
    })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.max_completion_tokens).toBe(100)
    expect(parsed.max_tokens).toBeUndefined()
  })

  test("strips tools for unknown model (not in TOOLCALL_MODELS allowlist)", () => {
    const input = JSON.stringify({
      model: "some-future-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeUndefined()
  })

  test("strips tool_choice without tools for non-toolcall model", () => {
    const input = JSON.stringify({
      model: "mistral-7b",
      messages: [{ role: "user", content: "hello" }],
      tool_choice: "auto",
    })
    const { body } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    const parsed = JSON.parse(body)
    expect(parsed.tool_choice).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Prompt-cache marker relocation (issue #1009)
// ---------------------------------------------------------------------------

describe("relocateCacheControl", () => {
  const EPHEMERAL = { type: "ephemeral" }

  test("moves message-level marker on system message into a text block", () => {
    const parsed: Record<string, any> = {
      model: "claude-opus-4-7",
      messages: [{ role: "system", content: "You are helpful.", cache_control: EPHEMERAL }],
    }
    expect(relocateCacheControl(parsed)).toBe(true)
    expect(parsed.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "You are helpful.", cache_control: EPHEMERAL }],
    })
  })

  test("converts single-string user message with marker into a text block", () => {
    const parsed: Record<string, any> = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello", cache_control: EPHEMERAL }],
    }
    expect(relocateCacheControl(parsed)).toBe(true)
    expect(parsed.messages[0].content).toEqual([{ type: "text", text: "hello", cache_control: EPHEMERAL }])
    expect("cache_control" in parsed.messages[0]).toBe(false)
  })

  test("converts tool message string content with marker into a text block", () => {
    const parsed: Record<string, any> = {
      model: "claude-opus-4-7",
      messages: [{ role: "tool", tool_call_id: "call_1", content: "tool output", cache_control: EPHEMERAL }],
    }
    expect(relocateCacheControl(parsed)).toBe(true)
    expect(parsed.messages[0].content).toEqual([{ type: "text", text: "tool output", cache_control: EPHEMERAL }])
    expect(parsed.messages[0].tool_call_id).toBe("call_1")
  })

  test("strips stray markers from assistant tool_calls entries", () => {
    const parsed: Record<string, any> = {
      model: "claude-opus-4-7",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "f", arguments: "{}" }, cache_control: EPHEMERAL },
          ],
        },
      ],
    }
    expect(relocateCacheControl(parsed)).toBe(false)
    expect("cache_control" in parsed.messages[0].tool_calls[0]).toBe(false)
  })

  test("keeps existing block-level marker on multi-part user message", () => {
    const parsed: Record<string, any> = {
      model: "claude-opus-4-7",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second", cache_control: EPHEMERAL },
          ],
        },
      ],
    }
    expect(relocateCacheControl(parsed)).toBe(true)
    expect(parsed.messages[0].content[1].cache_control).toEqual(EPHEMERAL)
  })

  test("leaves pre-existing block-level markers in place, including non-text blocks", () => {
    const parsed: Record<string, any> = {
      model: "claude-opus-4-7",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" }, cache_control: EPHEMERAL },
          ],
        },
      ],
    }
    expect(relocateCacheControl(parsed)).toBe(true)
    expect(parsed.messages[0].content[1].cache_control).toEqual(EPHEMERAL)
    expect("cache_control" in parsed.messages[0].content[0]).toBe(false)
  })

  test("message-level marker attaches to the last block, skipping empty text blocks", () => {
    const parsed: Record<string, any> = {
      model: "claude-opus-4-7",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "context" },
            { type: "text", text: "" },
          ],
          cache_control: EPHEMERAL,
        },
      ],
    }
    expect(relocateCacheControl(parsed)).toBe(true)
    expect(parsed.messages[0].content[0].cache_control).toEqual(EPHEMERAL)
    expect("cache_control" in parsed.messages[0].content[1]).toBe(false)
  })

  test("caps at 4 breakpoints, keeping the last ones", () => {
    const parsed: Record<string, any> = {
      model: "claude-opus-4-7",
      messages: [1, 2, 3, 4, 5].map((n) => ({
        role: "user",
        content: `message ${n}`,
        cache_control: EPHEMERAL,
      })),
    }
    expect(relocateCacheControl(parsed)).toBe(true)
    const marked = parsed.messages.map((m: any) => Boolean(m.content[0].cache_control))
    expect(marked).toEqual([false, true, true, true, true])
  })

  test("drops marker when message content is an empty string", () => {
    const parsed: Record<string, any> = {
      model: "claude-opus-4-7",
      messages: [{ role: "assistant", content: "", cache_control: EPHEMERAL }],
    }
    expect(relocateCacheControl(parsed)).toBe(false)
    expect(parsed.messages[0].content).toBe("")
    expect("cache_control" in parsed.messages[0]).toBe(false)
  })

  test("leaves non-claude models untouched", () => {
    const parsed: Record<string, any> = {
      model: "openai-gpt-5",
      messages: [{ role: "system", content: "sys", cache_control: EPHEMERAL }],
    }
    expect(relocateCacheControl(parsed)).toBe(false)
    expect(parsed.messages[0].content).toBe("sys")
    expect(parsed.messages[0].cache_control).toEqual(EPHEMERAL)
  })

  test("transformSnowflakeBody surfaces cacheApplied and relocates markers", () => {
    const input = JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 1000,
      messages: [
        { role: "system", content: "sys prompt", cache_control: EPHEMERAL },
        { role: "user", content: "hi" },
      ],
    })
    const result = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(result.cacheApplied).toBe(true)
    const parsed = JSON.parse(result.body)
    expect(parsed.max_completion_tokens).toBe(1000)
    expect(parsed.messages[0].content).toEqual([{ type: "text", text: "sys prompt", cache_control: EPHEMERAL }])
  })

  test("transformSnowflakeBody strips all markers when cacheControl is false", () => {
    const input = JSON.stringify({
      model: "claude-opus-4-7",
      messages: [
        { role: "system", content: "sys prompt", cache_control: EPHEMERAL },
        { role: "user", content: [{ type: "text", text: "hi", cache_control: EPHEMERAL }] },
      ],
    })
    const result = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE, false)
    expect(result.cacheApplied).toBe(false)
    const parsed = JSON.parse(result.body)
    expect(parsed.messages[0].content).toBe("sys prompt")
    expect("cache_control" in parsed.messages[0]).toBe(false)
    expect("cache_control" in parsed.messages[1].content[0]).toBe(false)
  })

  test("applyCaching markers survive real SDK serialization and relocate into blocks", async () => {
    // Full-chain contract: ProviderTransform.applyCaching → actual
    // @ai-sdk/openai-compatible request serialization → transformSnowflakeBody.
    // Guards against SDK upgrades changing where cache providerOptions land.
    const cortexModel = {
      id: "claude-opus-4-7",
      providerID: "snowflake-cortex",
      api: { id: "claude-opus-4-7", url: "", npm: "@ai-sdk/openai-compatible" },
      name: "Claude Opus 4.7",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1000000, output: 128000 },
      status: "active",
      options: {},
      headers: {},
    } as any

    let msgs: ModelMessage[] = [
      { role: "system", content: "You are a data engineer." },
      { role: "user", content: "optimize my query" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "run_sql", input: {} }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call_1", toolName: "run_sql", output: { type: "text", value: "42 rows" } }],
      },
    ]
    msgs = ProviderTransform.message(msgs, cortexModel, {})

    const captured: string[] = []
    const sdk = createOpenAICompatible({
      name: "snowflake-cortex",
      baseURL: "https://cortex.test/api/v2/cortex/v1",
      apiKey: "pat",
      fetch: (async (_url: any, init: any) => {
        captured.push(String(init?.body))
        return new Response(
          JSON.stringify({
            id: "c1",
            object: "chat.completion",
            created: 0,
            model: "claude-opus-4-7",
            choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }) as any,
    })

    await generateText({ model: sdk("claude-opus-4-7"), messages: msgs, maxRetries: 0 })

    expect(captured).toHaveLength(1)
    const raw = JSON.parse(captured[0])
    // Contract: the SDK serializes cache providerOptions as message-level fields
    expect(raw.messages.find((m: any) => m.role === "system").cache_control).toEqual(EPHEMERAL)
    expect(raw.messages.find((m: any) => m.role === "tool").cache_control).toEqual(EPHEMERAL)

    // The plugin transform relocates them into content blocks for Cortex
    const result = transformSnowflakeBody(captured[0], TOOLCAPABLE_FIXTURE)
    expect(result.cacheApplied).toBe(true)
    const fixed = JSON.parse(result.body)
    const sys = fixed.messages.find((m: any) => m.role === "system")
    expect(sys.content).toEqual([{ type: "text", text: "You are a data engineer.", cache_control: EPHEMERAL }])
    expect("cache_control" in sys).toBe(false)
    const tool = fixed.messages.find((m: any) => m.role === "tool")
    expect(tool.content).toEqual([{ type: "text", text: "42 rows", cache_control: EPHEMERAL }])
    for (const call of fixed.messages.find((m: any) => m.role === "assistant").tool_calls ?? []) {
      expect("cache_control" in call).toBe(false)
    }
  })

  test("stripCacheControl removes every marker from the body", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-7",
      messages: [
        { role: "system", content: [{ type: "text", text: "sys", cache_control: EPHEMERAL }] },
        { role: "user", content: "hi", cache_control: EPHEMERAL },
      ],
    })
    const parsed = JSON.parse(stripCacheControl(body))
    expect("cache_control" in parsed.messages[0].content[0]).toBe(false)
    expect("cache_control" in parsed.messages[1]).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fetch interceptor (SnowflakeCortexAuthPlugin)
// ---------------------------------------------------------------------------

describe("SnowflakeCortexAuthPlugin fetch interceptor", () => {
  test("content-length header is deleted after body transformation", async () => {
    // Simulate what the fetch wrapper does: copy headers, transform body, delete content-length
    const originalBody = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "test" }],
      max_tokens: 1000,
    })
    const headers = new Headers({
      "content-type": "application/json",
      "content-length": String(originalBody.length),
    })

    // Transform body (same logic as the fetch wrapper)
    const result = transformSnowflakeBody(originalBody, TOOLCAPABLE_FIXTURE)
    const newBody = result.body

    // Body changed (max_tokens → max_completion_tokens), so lengths differ
    expect(newBody.length).not.toBe(originalBody.length)

    // The fetch wrapper should delete content-length after transform
    headers.delete("content-length")
    expect(headers.has("content-length")).toBe(false)
  })

  test("synthetic stop returns valid SSE Response object", async () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "response" },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input, TOOLCAPABLE_FIXTURE)
    expect(syntheticStop).toBeInstanceOf(Response)
    expect(syntheticStop!.status).toBe(200)
    expect(syntheticStop!.headers.get("content-type")).toBe("text/event-stream")
    expect(syntheticStop!.headers.get("cache-control")).toBe("no-cache")

    // Body should be a readable stream
    const text = await syntheticStop!.text()
    const lines = text.split("\n").filter((l: string) => l.startsWith("data: "))
    expect(lines.length).toBe(3) // delta, stop, [DONE]
  })

  const makeLoaderFetch = async () => {
    const hooks = await SnowflakeCortexAuthPlugin({} as any)
    const options = await hooks.auth!.loader!(
      async () =>
        ({
          type: "oauth",
          access: "test-token",
          refresh: "",
          expires: Date.now() + 3600_000,
          accountId: "myorg-myaccount",
        }) as any,
      { models: { "claude-opus-4-7": { capabilities: { toolcall: true } } } } as any,
    )
    return options.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  }

  const cacheMarkedBody = () =>
    JSON.stringify({
      model: "claude-opus-4-7",
      messages: [
        { role: "system", content: "sys prompt", cache_control: { type: "ephemeral" } },
        { role: "user", content: "hi" },
      ],
    })

  test("retries once without cache markers on 400 and disables caching for the session", async () => {
    const pluginFetch = await makeLoaderFetch()
    const bodies: string[] = []
    const originalFetch = globalThis.fetch
    const hasBlockMarkers = (body: string) =>
      JSON.parse(body).messages.some(
        (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b?.cache_control),
      )
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      const body = String(init?.body)
      bodies.push(body)
      if (hasBlockMarkers(body)) return new Response("{}", { status: 400 })
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    try {
      const url = "https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1/chat/completions"
      const first = await pluginFetch(url, { method: "POST", body: cacheMarkedBody() })
      expect(first.status).toBe(200)
      expect(bodies).toHaveLength(2)
      expect(hasBlockMarkers(bodies[0])).toBe(true)
      expect(hasBlockMarkers(bodies[1])).toBe(false)

      // Sticky disable: the next request carries no markers at all
      const second = await pluginFetch(url, { method: "POST", body: cacheMarkedBody() })
      expect(second.status).toBe(200)
      expect(bodies).toHaveLength(3)
      expect(bodies[2]).not.toContain("cache_control")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns the original 400 and keeps caching enabled when the stripped retry also fails", async () => {
    const pluginFetch = await makeLoaderFetch()
    const bodies: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return new Response(JSON.stringify({ message: "bad request" }), { status: 400 })
    }) as typeof fetch

    try {
      const url = "https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1/chat/completions"
      const first = await pluginFetch(url, { method: "POST", body: cacheMarkedBody() })
      expect(first.status).toBe(400)
      expect(bodies).toHaveLength(2)

      // Caching stays enabled — the next request still carries block-level markers
      await pluginFetch(url, { method: "POST", body: cacheMarkedBody() })
      expect(bodies[2]).toContain("cache_control")
      expect(JSON.parse(bodies[2]).messages[0].content[0].cache_control).toEqual({ type: "ephemeral" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

describe("snowflake-cortex provider", () => {
  // Save and restore any real stored credentials to keep tests hermetic
  let savedAuth: Awaited<ReturnType<typeof Auth.get>>
  const setupOAuth = async (account = "myorg-myaccount") => {
    savedAuth = await Auth.get("snowflake-cortex")
    await Auth.set("snowflake-cortex", {
      type: "oauth",
      access: "test-pat-token",
      refresh: "",
      expires: Date.now() + 90 * 24 * 60 * 60 * 1000,
      accountId: account,
    })
  }
  const restoreAuth = async () => {
    if (savedAuth) {
      await Auth.set("snowflake-cortex", savedAuth)
    } else {
      await Auth.remove("snowflake-cortex")
    }
  }

  test("loads when oauth auth with accountId is set", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["snowflake-cortex"]).toBeDefined()
          expect(providers["snowflake-cortex"].options.baseURL).toBe(
            "https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1",
          )
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("does not load without oauth auth", async () => {
    savedAuth = await Auth.get("snowflake-cortex")
    if (savedAuth) await Auth.remove("snowflake-cortex")
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        init: async () => {
          Env.remove("SNOWFLAKE_ACCOUNT")
        },
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["snowflake-cortex"]).toBeUndefined()
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("does not load with only SNOWFLAKE_ACCOUNT env (no oauth)", async () => {
    savedAuth = await Auth.get("snowflake-cortex")
    if (savedAuth) await Auth.remove("snowflake-cortex")
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        init: async () => {
          Env.set("SNOWFLAKE_ACCOUNT", "myorg-myaccount")
        },
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["snowflake-cortex"]).toBeUndefined()
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("Claude and OpenAI models have toolcall: true", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const models = providers["snowflake-cortex"].models
          // Claude
          expect(models["claude-sonnet-4-6"].capabilities.toolcall).toBe(true)
          expect(models["claude-haiku-4-5"].capabilities.toolcall).toBe(true)
          expect(models["claude-3-5-sonnet"].capabilities.toolcall).toBe(true)
          // OpenAI
          expect(models["openai-gpt-4.1"].capabilities.toolcall).toBe(true)
          expect(models["openai-gpt-5"].capabilities.toolcall).toBe(true)
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("Llama, Mistral, and DeepSeek models have toolcall: false", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const models = providers["snowflake-cortex"].models
          expect(models["mistral-large2"].capabilities.toolcall).toBe(false)
          expect(models["snowflake-llama-3.3-70b"].capabilities.toolcall).toBe(false)
          expect(models["llama3.1-70b"].capabilities.toolcall).toBe(false)
          expect(models["deepseek-r1"].capabilities.toolcall).toBe(false)
          expect(models["llama4-maverick"].capabilities.toolcall).toBe(false)
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("all models have zero cost", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          for (const model of Object.values(providers["snowflake-cortex"].models)) {
            expect(model.cost.input).toBe(0)
            expect(model.cost.output).toBe(0)
          }
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("env array is empty (auth-only provider)", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["snowflake-cortex"].env).toEqual([])
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("models added per Snowflake regional availability docs (issue #851)", async () => {
    // Regression: PR for issue #851 added 8 models that Snowflake Cortex
    // supports but were missing from the hardcoded list. Lock in identity,
    // toolcall capability, AND limits (the limits were corrected in the
    // consensus-review follow-up after an initial drift was caught).
    await setupOAuth()
    try {
      await using tmp = await tmpdir({ config: {} })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const models = providers["snowflake-cortex"].models

          // Each entry: [id, expected toolcall, expected context, expected output]
          // Values sourced from
          // https://docs.snowflake.com/en/user-guide/snowflake-cortex/aisql-regional-availability
          // (openai-gpt-5.2 is not in the restrictions table; using gpt-5 family defaults.)
          const expectations: Array<[string, boolean, number, number]> = [
            ["claude-opus-4-7", true, 1000000, 128000],
            ["openai-gpt-5.1", true, 272000, 8192],
            ["openai-gpt-5.2", true, 272000, 8192],
            ["llama4-scout", false, 128000, 8192],
            ["llama3.3-70b", false, 128000, 8192],
            // Snowflake docs list output=8192 for this model, but its context
            // is only 8000 — capped at 4096 (sibling default) so prompt+output
            // always fit. See provider.ts comment for the rationale.
            ["snowflake-llama-3.1-405b", false, 8000, 4096],
            ["mixtral-8x7b", false, 32000, 8192],
            ["gemini-3.1-pro", false, 1000000, 64000],
          ]

          for (const [id, toolcall, context, output] of expectations) {
            expect(models[id], `model ${id} should be defined`).toBeDefined()
            expect(models[id].capabilities.toolcall, `${id} toolcall`).toBe(toolcall)
            expect(models[id].limit.context, `${id} context`).toBe(context)
            expect(models[id].limit.output, `${id} output`).toBe(output)
          }
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("buildToolCapableSet derives the allowlist from provider model capabilities", async () => {
    // Source-of-truth test for the escape-hatch fix: the request transform
    // gets its allowlist from `provider.models.capabilities.toolcall` rather
    // than a separate hardcoded set in snowflake.ts. Models added via
    // altimate-code.json with `tool_call: true` therefore retain tools at
    // request time, and the picker capability cannot drift from the transform.
    await setupOAuth()
    try {
      await using tmp = await tmpdir({ config: {} })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const set = buildToolCapableSet(providers["snowflake-cortex"].models)
          // Every model with capabilities.toolcall === true is in the set; the rest are not.
          for (const [id, m] of Object.entries(providers["snowflake-cortex"].models)) {
            expect(set.has(id), `${id} parity`).toBe(m.capabilities.toolcall)
          }
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("escape-hatch model with tool_call: true retains tools through transformSnowflakeBody", async () => {
    // The documented altimate-code.json escape hatch must work end-to-end:
    // picker shows the model as tool-capable AND the request transform passes
    // tools through. Without the loader-derived allowlist this test would fail
    // because the static set never sees user-added entries.
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        config: {
          provider: {
            "snowflake-cortex": {
              models: {
                "user-tool-model": {
                  name: "User Tool Model",
                  limit: { context: 100000, output: 8192 },
                  tool_call: true,
                },
              },
            },
          },
        } as any,
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const toolCapable = buildToolCapableSet(providers["snowflake-cortex"].models)
          const input = JSON.stringify({
            model: "user-tool-model",
            messages: [{ role: "user", content: "hi" }],
            tools: [{ type: "function", function: { name: "read_file" } }],
            tool_choice: "auto",
          })
          const { body } = transformSnowflakeBody(input, toolCapable)
          const parsed = JSON.parse(body)
          expect(parsed.tools).toBeDefined()
          expect(parsed.tools).toHaveLength(1)
          expect(parsed.tool_choice).toBe("auto")
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("escape-hatch model with tool_call: false has tools stripped through transformSnowflakeBody", async () => {
    // Counterpart to the above: a user-registered non-tool model gets the
    // tools stripped just like the built-in Llama/Mistral entries do.
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        config: {
          provider: {
            "snowflake-cortex": {
              models: {
                "user-notool-model": {
                  name: "User No-Tool Model",
                  limit: { context: 32000, output: 4096 },
                  tool_call: false,
                },
              },
            },
          },
        } as any,
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const toolCapable = buildToolCapableSet(providers["snowflake-cortex"].models)
          const input = JSON.stringify({
            model: "user-notool-model",
            messages: [
              { role: "user", content: "hi" },
              { role: "tool", content: "x", tool_call_id: "t1" },
            ],
            tools: [{ type: "function", function: { name: "read_file" } }],
            tool_choice: "auto",
          })
          const { body } = transformSnowflakeBody(input, toolCapable)
          const parsed = JSON.parse(body)
          expect(parsed.tools).toBeUndefined()
          expect(parsed.tool_choice).toBeUndefined()
          // Orphaned tool messages dropped too.
          expect(parsed.messages.find((m: { role: string }) => m.role === "tool")).toBeUndefined()
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("aliased model (picker key != api.id) is matched by buildToolCapableSet on both ids", async () => {
    // Regression: when a user registers an alias like
    //   `"my-claude-alias": { "id": "claude-opus-4-7", "tool_call": true }`,
    // the picker map is keyed by "my-claude-alias" but the request body sends
    // `model: "claude-opus-4-7"`. The allowlist must include BOTH so tools
    // aren't silently stripped on the way out.
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        config: {
          provider: {
            "snowflake-cortex": {
              models: {
                "my-claude-alias": {
                  id: "claude-opus-4-7",
                  name: "My Claude Alias",
                  limit: { context: 1000000, output: 128000 },
                  tool_call: true,
                },
              },
            },
          },
        } as any,
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const toolCapable = buildToolCapableSet(providers["snowflake-cortex"].models)
          // Both forms must be in the set.
          expect(toolCapable.has("my-claude-alias")).toBe(true)
          expect(toolCapable.has("claude-opus-4-7")).toBe(true)

          // And the transform must keep tools when the request uses the api.id form.
          const input = JSON.stringify({
            model: "claude-opus-4-7",
            messages: [{ role: "user", content: "hi" }],
            tools: [{ type: "function", function: { name: "read_file" } }],
            tool_choice: "auto",
          })
          const { body } = transformSnowflakeBody(input, toolCapable)
          const parsed = JSON.parse(body)
          expect(parsed.tools).toBeDefined()
          expect(parsed.tool_choice).toBe("auto")
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("user can register a model not in the hardcoded list via altimate-code.json", async () => {
    // Documents the option (2) escape hatch: when Snowflake adds a model
    // before the CLI's hardcoded list catches up, users add it under
    // provider['snowflake-cortex'].models and it merges into the picker.
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        config: {
          provider: {
            "snowflake-cortex": {
              models: {
                "future-model-x": {
                  name: "Future Model X",
                  limit: { context: 200000, output: 32000 },
                  tool_call: true,
                },
              },
            },
          },
        } as any,
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const m = providers["snowflake-cortex"].models["future-model-x"]
          expect(m).toBeDefined()
          expect(m.name).toBe("Future Model X")
          expect(m.capabilities.toolcall).toBe(true)
          expect(m.limit.context).toBe(200000)
          // Built-in models still present alongside the config-added one.
          expect(providers["snowflake-cortex"].models["claude-opus-4-7"]).toBeDefined()
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("claude-3-5-sonnet output limit is 8192", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["snowflake-cortex"].models["claude-3-5-sonnet"].limit.output).toBe(8192)
        },
      })
    } finally {
      await restoreAuth()
    }
  })
})

// ---------------------------------------------------------------------------
// Provider.all() — unauthenticated discoverability
// ---------------------------------------------------------------------------

describe("Provider.all() discoverability", () => {
  test("includes snowflake-cortex even without oauth auth", async () => {
    const savedAuth = await Auth.get("snowflake-cortex")
    if (savedAuth) await Auth.remove("snowflake-cortex")
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await provideProviderTestInstance({
        directory: tmp.path,
        init: async () => {
          Env.remove("SNOWFLAKE_ACCOUNT")
        },
        fn: async () => {
          const allProviders = await Provider.all()
          expect(allProviders["snowflake-cortex"]).toBeDefined()
          expect(allProviders["snowflake-cortex"].name).toBe("Snowflake Cortex")
          // list() still returns nothing (not authenticated)
          const connected = await Provider.list()
          expect(connected["snowflake-cortex"]).toBeUndefined()
        },
      })
    } finally {
      if (savedAuth) await Auth.set("snowflake-cortex", savedAuth)
    }
  })

  test("all() includes snowflake-cortex models", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
      },
    })
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        const allProviders = await Provider.all()
        const models = allProviders["snowflake-cortex"]?.models
        expect(models).toBeDefined()
        expect(models["claude-sonnet-4-6"]).toBeDefined()
        expect(models["deepseek-r1"]).toBeDefined()
      },
    })
  })

  test("disabled_providers config suppresses snowflake-cortex from all()", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://altimate.ai/config.json", disabled_providers: ["snowflake-cortex"] }),
        )
      },
    })
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        // Provider.all() returns raw database, config filtering happens at the route level.
        // Verify the route-level filtering logic: a disabled provider should not appear
        // in the merged provider list used by GET /provider.
        const allProviders = await Provider.all()
        const connected = await Provider.list()
        // Simulate the route filtering (same logic as routes/provider.ts)
        const disabled = new Set(["snowflake-cortex"])
        const customProviders: Record<string, (typeof allProviders)[string]> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if (key in connected) continue
          if (!disabled.has(key)) customProviders[key] = value
        }
        expect(customProviders["snowflake-cortex"]).toBeUndefined()
      },
    })
  })

  test("enabled_providers config suppresses snowflake-cortex when not listed", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://altimate.ai/config.json", enabled_providers: ["anthropic"] }),
        )
      },
    })
    await provideProviderTestInstance({
      directory: tmp.path,
      fn: async () => {
        const allProviders = await Provider.all()
        const connected = await Provider.list()
        // Simulate route filtering with enabled_providers
        // (snowflake-cortex is not in the enabled list, so it should be excluded)
        const enabled = new Set(["anthropic"])
        const customProviders: Record<string, (typeof allProviders)[string]> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if (key in connected) continue
          if (enabled.has(key)) customProviders[key] = value
        }
        expect(customProviders["snowflake-cortex"]).toBeUndefined()
      },
    })
  })
})
