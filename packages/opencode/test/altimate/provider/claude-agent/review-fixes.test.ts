import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { generateObject, generateText, jsonSchema } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ClaudeAgentCatalog } from "@/altimate/provider/claude-agent/catalog"
import type { ClaudeSessions } from "@/altimate/provider/claude-agent/claude/sessions"
import { ClaudeAgentID } from "@/altimate/provider/claude-agent/id"
import { ClaudeAgentLanguageModel } from "@/altimate/provider/claude-agent/language-model/claude-agent-language-model"
import { ToolAborted } from "@/altimate/provider/claude-agent/tools/aborted"
import { ToolResult } from "@/altimate/provider/claude-agent/tools/result"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { ClaudeAgentError } from "@/altimate/provider/claude-agent/language-model/claude-agent-error"
import { ProviderID } from "@/provider/schema"
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk"

// A Claude reply as the SDK streams it: one text block, then the turn's result.
function reply(text: string): SDKMessage[] {
  const usage = { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const stream = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: null, event }) as unknown as SDKMessage
  return [
    stream({ type: "message_start", message: { id: "msg_1", model: "claude-haiku-5-5", usage } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    stream({ type: "content_block_stop", index: 0 }),
    stream({ type: "message_delta", usage }),
    stream({ type: "message_stop" }),
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      num_turns: 1,
      stop_reason: "end_turn",
      usage,
    } as unknown as SDKMessage,
  ]
}

function model(text: string) {
  const requests: ClaudeSessions.Request[] = []
  const language = new ClaudeAgentLanguageModel.Model("haiku", {
    run: async (request) => {
      requests.push(request)
      for (const message of reply(text)) request.emit(message)
    },
  })
  return { language, requests }
}

describe("Claude Agent generate calls", () => {
  test("generateText collects the streamed reply and its usage", async () => {
    const { language } = model("Hello from Claude")
    const result = await generateText({ model: language, prompt: "hi" })
    expect(result.text).toBe("Hello from Claude")
    expect(result.finishReason).toBe("stop")
    expect(result.usage.outputTokens).toBe(7)
  })

  test("generateObject asks for JSON in the prompt and accepts a fenced reply", async () => {
    const { language, requests } = model('```json\n{"name":"orders","rows":3}\n```')
    const schema = jsonSchema<{ name: string; rows: number }>({
      type: "object",
      properties: { name: { type: "string" }, rows: { type: "number" } },
      required: ["name", "rows"],
    })
    const result = await generateObject({ model: language, schema, prompt: "describe the table" })
    expect(result.object).toEqual({ name: "orders", rows: 3 })
    // A side call uses the request's system messages as its whole system prompt.
    expect(String(requests[0]?.system)).toContain("Respond with only a JSON value")
  })
})

describe("Claude Agent stopped tools", () => {
  const sessionID = SessionID.make("ses_claude")
  const claude = ClaudeAgentCatalog.provider({ models: [{ id: "sonnet", name: "Sonnet", efforts: [] }] }, {}).models
    .sonnet!
  const callMetadata = { [ClaudeAgentID.ID]: { sessionID: "claude-session", messageID: "claude-message" } }

  function history(state: Record<string, unknown>) {
    const base = (messageID: string, id: string) => ({
      id: PartID.make(`prt_${id}`),
      sessionID,
      messageID: MessageID.make(`msg_${messageID}`),
    })
    return [
      {
        info: { id: "msg_user", sessionID, role: "user", time: { created: 0 }, agent: "builder", model: { providerID: claude.providerID, modelID: claude.id } },
        parts: [{ ...base("user", "u1"), type: "text", text: "run it" }],
      },
      {
        info: {
          id: "msg_assistant",
          sessionID,
          role: "assistant",
          time: { created: 0 },
          parentID: "msg_user",
          providerID: claude.providerID,
          modelID: claude.api.id,
          mode: "",
          agent: "builder",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ ...base("assistant", "a1"), type: "tool", callID: "toolu_1", tool: "bash", metadata: callMetadata, state }],
      },
    ] as unknown as SessionV1.WithParts[]
  }

  async function collected(state: Record<string, unknown>) {
    const messages = await MessageV2.toModelMessages(history(state) as unknown as MessageV2.WithParts[], claude)
    // Results start after the assistant message that called the tool.
    return ToolResult.collect(messages as never, 2)
  }

  test("a tool stopped with partial output interrupts the waiting Claude turn", async () => {
    const result = await collected({
      status: "error",
      input: { command: "sleep 100" },
      error: "Tool execution aborted",
      metadata: { interrupted: true, output: "partial" },
      time: { start: 0, end: 1 },
    })
    expect(result.aborted).toBe(true)
    expect(result.results.get("toolu_1")?.mcp.content).toEqual([{ type: "text", text: "partial" }])
  })

  test("a tool stopped before it ran interrupts the waiting Claude turn", async () => {
    const result = await collected({ status: "running", input: { command: "sleep 100" }, time: { start: 0 } })
    expect(result.aborted).toBe(true)
  })

  test("an ordinary tool failure is returned to Claude without interrupting it", async () => {
    const result = await collected({
      status: "error",
      input: { command: "false" },
      error: "exit code 1",
      metadata: {},
      time: { start: 0, end: 1 },
    })
    expect(result.aborted).toBe(false)
    expect(result.results.get("toolu_1")?.mcp.isError).toBe(true)
  })

  test("a rejection that stopped the session interrupts the waiting Claude turn", async () => {
    const result = await collected({
      status: "error",
      input: { command: "rm -rf build" },
      error: "The user rejected permission to use this specific tool call.",
      metadata: { rejected: true },
      time: { start: 0, end: 1 },
    })
    expect(result.aborted).toBe(true)
  })

  test("other providers' call metadata is left as is", () => {
    const openai = { openai: { itemId: "fc_1" } }
    expect(ToolAborted.mark(openai)).toBe(openai)
    expect(ToolAborted.mark(undefined)).toBeUndefined()
  })
})

describe("Claude Agent history and errors", () => {
  test("images a tool returned travel with its result, under the shipped attachment prompt", () => {
    const image = { type: "file" as const, mediaType: "image/png", data: "aGVsbG8=" }
    const prompt = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "toolu_1", toolName: "read", input: {} }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "toolu_1", toolName: "read", output: { type: "text", value: "ok" } }],
      },
      { role: "user", content: [{ type: "text", text: MessageV2.SYNTHETIC_ATTACHMENT_PROMPT }, image] },
    ]
    const result = ToolResult.collect(prompt as never, 1)
    expect(result.end).toBe(3)
    expect(result.results.get("toolu_1")?.mcp.content).toContainEqual({
      type: "image",
      mimeType: "image/png",
      data: "aGVsbG8=",
    })
  })

  test("a prompt-too-long result is classified as context overflow, so the session compacts", () => {
    const failure = ClaudeAgentError.make()({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Prompt is too long",
      terminal_reason: "prompt_too_long",
      num_turns: 1,
    } as unknown as SDKMessage)
    const stored = MessageV2.fromError(failure, { providerID: ProviderID.make(ClaudeAgentID.ID) })
    expect(stored.name).toBe("ContextOverflowError")
  })

  test("other Claude failures stay ordinary errors", () => {
    const failure = ClaudeAgentError.make()({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Something else went wrong",
      num_turns: 1,
    } as unknown as SDKMessage)
    expect(MessageV2.fromError(failure, { providerID: ProviderID.make(ClaudeAgentID.ID) }).name).not.toBe(
      "ContextOverflowError",
    )
  })
})

describe("Claude Agent saved model lists", () => {
  const probe = (account: AccountInfo) => ({
    version: "2.1.322",
    account,
    models: [{ value: "opus", displayName: "Opus 5.5", description: "", resolvedModel: "claude-opus-5-5" }],
  })

  test("a project with its own connection settings keeps its own list and prices", async () => {
    const gateway = { ANTHROPIC_API_KEY: "sk-ant-test" }
    await ClaudeAgentCatalog.update(probe({ apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" } as AccountInfo), undefined, gateway)
    await ClaudeAgentCatalog.update(probe({ apiProvider: "firstParty", subscriptionType: "Claude Max" } as AccountInfo), undefined)
    expect((await ClaudeAgentCatalog.load(gateway)).priceSource).toBe("anthropic")
    expect((await ClaudeAgentCatalog.load()).priceSource).toBeUndefined()
  })
})
