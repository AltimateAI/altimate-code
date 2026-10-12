import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test"
import z from "zod"
import { Auth } from "../../src/auth"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { LLM } from "../../src/session/llm"
import { MessageID, SessionID } from "../../src/session/schema"
import { SystemPrompt } from "../../src/session/system"
import { Retrieval } from "../../src/tool/retrieval"
import { RunTracing } from "../../src/cli/cmd/run-tracing"
import { Trace, type TraceFile } from "../../src/altimate/observability/tracing"

const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore()
})

const sessionID = SessionID.make("ses_request_trace")
const providerID = ProviderID.make("openai")
const model: Provider.Model = {
  id: ModelID.make("gpt-4.1"),
  providerID,
  api: { id: "gpt-4.1", npm: "@ai-sdk/openai", url: "https://unused.invalid" },
  name: "Fake request model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 4096 },
  status: "active",
  release_date: "2025-01-01",
  options: { apiKey: "model-options-secret" },
  headers: { Authorization: "model-header-secret" },
  variants: { high: { reasoningEffort: "high" } },
}

function input(): LLM.StreamInput {
  return {
    sessionID,
    messageID: "msg_assistant_request",
    model,
    agent: {
      name: "analyst",
      mode: "primary",
      prompt: "agent prompt",
      options: {},
      permission: [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "denied", pattern: "*", action: "deny" },
      ],
    },
    user: {
      id: MessageID.make("msg_user_request"),
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "analyst",
      model: { providerID, modelID: model.id },
      variant: "high",
      system: "user prompt",
      tools: { user_disabled: false },
    },
    system: ["custom prompt"],
    abort: new AbortController().signal,
    messages: [
      { role: "system", content: "history system" },
      { role: "user", content: "Read the archive" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "old-call", toolName: "historical", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "old-call",
            toolName: "historical",
            output: { type: "text", value: "archive" },
          },
        ],
      },
      { role: "user", content: "Continue" },
    ],
    tools: {
      read: tool({ description: "Read file", inputSchema: z.object({ path: z.string() }) }),
      query: tool({
        description: "Run query",
        inputSchema: jsonSchema({ type: "object", properties: { sql: { type: "string" } }, required: ["sql"] }),
      }),
      denied: tool({ inputSchema: z.object({}) }),
      user_disabled: tool({ inputSchema: z.object({}) }),
      retrieved_out: tool({ inputSchema: z.object({}) }),
      invalid: tool({ inputSchema: z.object({ error: z.string() }) }),
    },
  }
}

function setup(enabled = true) {
  const exported: TraceFile[] = []
  const root = Trace.withExporters([
    {
      name: "memory",
      export: async (trace) => {
        exported.push(trace)
        return undefined
      },
    },
  ])
  root.startTrace(sessionID, {})
  const recorder = new RunTracing(sessionID, root, { get: async () => undefined, children: async () => [] })
  const hooks = { system: "plugin prompt", instructions: "plugin instructions" }
  const language = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", delta: "ok" },
        { type: "text-end", id: "text-0" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ]),
    }),
  })
  spies.push(
    spyOn(Config, "get").mockResolvedValue({ tracing: { enabled } }),
    spyOn(Provider, "getLanguage").mockResolvedValue(language),
    spyOn(Provider, "getProvider").mockResolvedValue({
      id: providerID,
      name: "Fake provider",
      source: "config",
      env: [],
      options: { apiKey: "provider-options-secret", headers: { Authorization: "provider-header-secret" } },
      models: { [model.id]: model },
    }),
    spyOn(Auth, "get").mockResolvedValue({
      type: "oauth",
      access: "auth-access-secret",
      refresh: "auth-refresh-secret",
      expires: Number.MAX_SAFE_INTEGER,
    }),
    spyOn(Plugin, "trigger").mockImplementation(async (name, _input, output) => {
      if (name === "experimental.chat.system.transform") (output as { system: string[] }).system.push(hooks.system)
      if (name === "chat.params") {
        const params = output as { options: Record<string, unknown> }
        params.options.instructions = `${params.options.instructions}\n${hooks.instructions}`
      }
      if (name === "chat.headers")
        (output as { headers: Record<string, string> }).headers.Authorization = "plugin-header-secret"
      return output
    }),
    spyOn(Retrieval, "enabled").mockReturnValue(true),
    spyOn(Retrieval, "select").mockImplementation(
      (_query, _tools, options) => new Set(["read", "query", ...(options?.keep ?? [])]),
    ),
  )
  const publish = spyOn(Bus, "publish").mockImplementation(async (definition, properties) => {
    await recorder.observe({ type: definition.type, properties })
  })
  spies.push(publish)
  return {
    hooks,
    language,
    publish,
    async finish() {
      await recorder.finish()
      return exported[0]!
    },
  }
}

async function stream(request = input()) {
  const result = await LLM.stream(request)
  expect(await result.text).toBe("ok")
}

type Snapshot = { hash: string; content?: unknown }
type RequestInput = { system: Snapshot; tools: Snapshot; instructions: Snapshot }

describe("LLM request trace boundary", () => {
  test("captures finalized inputs and deduplicates unchanged snapshots across real stream calls", async () => {
    const run = setup()
    await stream()
    await stream()
    run.hooks.system = "changed plugin prompt"
    run.hooks.instructions = "changed plugin instructions"
    const changed = input()
    changed.tools.query = tool({ inputSchema: z.object({ sql: z.string(), limit: z.number() }) })
    await stream(changed)

    const trace = await run.finish()
    const spans = trace.spans.filter((span) => span.name === "llm-request")
    expect(spans).toHaveLength(3)
    expect(run.language.doStreamCalls).toHaveLength(3)
    expect(spans[0]!.attributes).toMatchObject({
      sessionId: sessionID,
      messageId: "msg_assistant_request",
      userMessageId: "msg_user_request",
      agent: "analyst",
    })
    expect(spans[0]!.model).toEqual({ providerId: "openai", modelId: model.id, variant: "high" })
    expect(new Set(spans.map((span) => span.attributes?.requestId)).size).toBe(3)
    const [first, second, third] = spans.map((span) => span.input as RequestInput)
    expect(first!.system.content).toBe("agent prompt\ncustom prompt\nuser prompt\n\nplugin prompt\n\nhistory system")
    expect(first!.instructions.content).toBe(`${SystemPrompt.instructions()}\nplugin instructions`)
    const catalog = first!.tools.content as Array<{ name: string; active: boolean; inputSchema: unknown }>
    expect(catalog.map((entry) => [entry.name, entry.active])).toEqual([
      ["historical", true],
      ["invalid", false],
      ["query", true],
      ["read", true],
    ])
    expect(catalog.find((entry) => entry.name === "query")!.inputSchema).toEqual({
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
    })
    expect(catalog.find((entry) => entry.name === "read")!.inputSchema).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    })
    expect(run.language.doStreamCalls[0]!.tools?.map((entry) => entry.name).sort()).toEqual([
      "historical",
      "query",
      "read",
    ])
    for (const key of ["system", "tools", "instructions"] as const) {
      expect(first![key].hash).toMatch(/^[a-f0-9]{64}$/)
      expect(second![key]).toEqual({ hash: first![key].hash })
      expect(third![key].hash).not.toBe(first![key].hash)
      expect(third![key].content).toBeDefined()
    }
    expect(JSON.stringify(trace)).not.toContain("-secret")
    expect(JSON.stringify(run.publish.mock.calls)).not.toContain("-secret")
    expect(trace.metadata.captureOmissions?.some((value) => value.startsWith("effective_system_prompt:"))).toBe(false)
  })

  test("disabled tracing skips publication and trace-only schema access without changing generation", async () => {
    const run = setup(false)
    const request = input()
    let traceSchemaReads = 0
    Object.defineProperty(request.tools.invalid!, "inputSchema", {
      get() {
        traceSchemaReads++
        throw new Error("inactive schema must not be resolved")
      },
    })
    await stream(request)
    expect(run.publish).not.toHaveBeenCalled()
    expect(traceSchemaReads).toBe(0)
    const trace = await run.finish()
    expect(trace.spans.filter((span) => span.name === "llm-request")).toHaveLength(0)
    expect(run.language.doStreamCalls).toHaveLength(1)
  })

  test("request event failure never interrupts generation", async () => {
    const run = setup()
    run.publish.mockRejectedValue(new Error("trace transport unavailable"))
    await stream()
    expect(run.publish).toHaveBeenCalledTimes(1)
    expect(run.language.doStreamCalls).toHaveLength(1)
    const trace = await run.finish()
    expect(trace.spans.filter((span) => span.name === "llm-request")).toHaveLength(0)
  })
})
