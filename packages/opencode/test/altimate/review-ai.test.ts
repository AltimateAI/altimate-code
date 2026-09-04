import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { Dispatcher } from "@/altimate/native"
import { runAiReview, type AiReviewFile } from "@/altimate/review/ai-review"
import { NO_MODEL_REASON } from "@/altimate/review/verdict"
import { sessionModelFromContext } from "@/altimate/tools/dbt-pr-review"

afterEach(() => mock.restore())

function stubModelAndPrompt(parseResult: any = { data: { findings: [] } }) {
  let parseCalls = 0
  spyOn(Provider as any, "defaultModel").mockImplementation(async () => ({
    providerID: "test-provider",
    modelID: "test-model",
  }))
  spyOn(Provider as any, "getModel").mockImplementation(async () => ({
    providerID: "test-provider",
    id: "test-model",
    modelID: "test-model",
  }))
  spyOn(Dispatcher as any, "call").mockImplementation(async (method: string) => {
    if (method === "altimate_core.review_ai_prompt") return { data: { prompt: "Review the change." } }
    if (method === "altimate_core.review_ai_parse") {
      parseCalls++
      return parseResult
    }
    throw new Error(`unexpected dispatcher method: ${method}`)
  })
  return () => parseCalls
}

function reviewFile(index: number): AiReviewFile {
  return {
    path: `models/model_${index}.sql`,
    status: "modified",
    model: `model_${index}`,
    diff: "+select 1\n",
  }
}

describe("runAiReview model selection", () => {
  test("skips without consulting the session model when no explicit model is configured", async () => {
    const defaultModel = spyOn(Provider as any, "defaultModel")
    const getModel = spyOn(Provider as any, "getModel")
    const dispatcher = spyOn(Dispatcher as any, "call")

    const result = await runAiReview({
      files: [reviewFile(0)],
      grounding: [],
      allowSessionModel: false,
    })

    expect(result).toMatchObject({ findings: [], status: "skipped", reason: NO_MODEL_REASON, promptChars: 0 })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(defaultModel).not.toHaveBeenCalled()
    expect(getModel).not.toHaveBeenCalled()
    expect(dispatcher).not.toHaveBeenCalled()
  })

  test("returns an error naming an unavailable configured model without falling back", async () => {
    const defaultModel = spyOn(Provider as any, "defaultModel")
    const getModel = spyOn(Provider as any, "getModel").mockRejectedValue(new Error("provider is not configured"))
    const dispatcher = spyOn(Dispatcher as any, "call")
    const stream = spyOn(LLM as any, "stream")

    const result = await runAiReview({
      files: [reviewFile(0)],
      grounding: [],
      model: "openrouter/openai/gpt-5",
      allowSessionModel: false,
    })

    expect(result).toMatchObject({
      findings: [],
      status: "error",
      reason:
        "configured AI model not available: openrouter/openai/gpt-5 — Error: provider is not configured",
      model: "openrouter/openai/gpt-5",
    })
    expect(getModel).toHaveBeenCalledWith("openrouter", "openai/gpt-5")
    expect(defaultModel).not.toHaveBeenCalled()
    expect(dispatcher).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })

  test("uses the active session model without consulting the provider default", async () => {
    const defaultModel = spyOn(Provider as any, "defaultModel")
    const getModel = spyOn(Provider as any, "getModel").mockResolvedValue({
      providerID: "openrouter",
      id: "openai/gpt-5",
      modelID: "openai/gpt-5",
    })
    spyOn(Dispatcher as any, "call").mockResolvedValue({ data: {} })

    const result = await runAiReview({
      files: [reviewFile(0)],
      grounding: [],
      allowSessionModel: true,
      sessionModel: "openrouter/openai/gpt-5",
    })

    expect(result).toMatchObject({
      findings: [],
      status: "skipped",
      reason: "reviewer prompt unavailable",
      model: "openrouter/openai/gpt-5",
    })
    expect(getModel).toHaveBeenCalledWith("openrouter", "openai/gpt-5")
    expect(defaultModel).not.toHaveBeenCalled()
  })

  test("reads the active assistant model from the invoking tool context", async () => {
    const getMessage = spyOn(MessageV2 as any, "get").mockReturnValue({
      info: {
        role: "assistant",
        providerID: "openrouter",
        modelID: "openai/gpt-5",
      },
    })

    const model = await sessionModelFromContext({ sessionID: "session-id", messageID: "message-id" } as any)

    expect(model).toBe("openrouter/openai/gpt-5")
    expect(getMessage).toHaveBeenCalledWith({ sessionID: "session-id", messageID: "message-id" })
  })
})

describe("runAiReview stream handling", () => {
  test("returns timeout when pre-stream setup never resolves", async () => {
    spyOn(Provider as any, "defaultModel").mockResolvedValue({
      providerID: "test-provider",
      modelID: "test-model",
    })
    spyOn(Provider as any, "getModel").mockResolvedValue({
      providerID: "test-provider",
      id: "test-model",
      modelID: "test-model",
    })
    spyOn(Dispatcher as any, "call").mockImplementation(
      (() => new Promise(() => {})) as any,
    )
    const stream = spyOn(LLM as any, "stream")

    const result = await runAiReview({
      files: [reviewFile(0)],
      grounding: [],
      allowSessionModel: true,
      timeoutMs: 5,
    })

    expect(result).toMatchObject({
      findings: [],
      status: "timeout",
      reason: "timed out after 0.005s (raise aiTimeoutSeconds / --ai-timeout)",
      model: "test-provider/test-model",
    })
    expect(stream).not.toHaveBeenCalled()
  })

  test("caps the timeout to the files included in the prompt", async () => {
    stubModelAndPrompt()
    const nativeSetTimeout = globalThis.setTimeout
    const delays: number[] = []
    spyOn(globalThis as any, "setTimeout").mockImplementation(
      ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        delays.push(Number(delay))
        return nativeSetTimeout(callback, delay, ...args)
      }) as any,
    )
    const stream = spyOn(LLM as any, "stream").mockImplementation(async () => ({
      fullStream: {
        async *[Symbol.asyncIterator]() {},
      },
      text: Promise.resolve("[]"),
    }))

    const result = await runAiReview({
      files: Array.from({ length: 25 }, (_, index) => reviewFile(index)),
      grounding: [],
      allowSessionModel: true,
    })

    expect(result).toMatchObject({ findings: [], status: "ok", model: "test-provider/test-model" })
    const request = stream.mock.calls[0][0] as { messages: Array<{ content: string }> }
    expect(result.promptChars).toBe(request.messages[0]!.content.length)
    expect(delays).toContain(200_000)
    expect(stream.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 8_192 })
  })

  test("passes an explicit output budget to the LLM stream", async () => {
    stubModelAndPrompt()
    const stream = spyOn(LLM as any, "stream").mockImplementation(async () => ({
      fullStream: {
        async *[Symbol.asyncIterator]() {},
      },
      text: Promise.resolve("[]"),
    }))

    await runAiReview({
      files: [reviewFile(0)],
      grounding: [],
      allowSessionModel: true,
      maxOutputTokens: 12_288,
    })

    expect(stream.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 12_288 })
  })

  test("reports provider usage, including reasoning tokens from provider metadata", async () => {
    stubModelAndPrompt()
    spyOn(LLM as any, "stream").mockImplementation(async () => ({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "finish-step",
            finishReason: "stop",
            rawFinishReason: "stop",
            usage: { inputTokens: 321, outputTokens: 144 },
            providerMetadata: {
              openai: { usage: { completion_tokens_details: { reasoning_tokens: 89 } } },
            },
          }
          yield {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 321, outputTokens: 144 },
          }
        },
      },
      text: Promise.resolve("[]"),
    }))

    const result = await runAiReview({ files: [reviewFile(0)], grounding: [], allowSessionModel: true })

    expect(result).toMatchObject({
      status: "ok",
      promptTokens: 321,
      completionTokens: 144,
      reasoningTokens: 89,
    })
  })

  test("reports a truncation error instead of partial findings", async () => {
    const parseCalls = stubModelAndPrompt()
    spyOn(LLM as any, "stream").mockImplementation(async () => ({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "finish",
            finishReason: "length",
            rawFinishReason: "max_tokens",
            totalUsage: { inputTokens: 500, outputTokens: 4_096 },
          }
        },
      },
      text: Promise.resolve('[{"file":"models/model_0.sql","title":"partial","body":"partial"}]'),
    }))

    const result = await runAiReview({ files: [reviewFile(0)], grounding: [], allowSessionModel: true })

    expect(result).toMatchObject({
      findings: [],
      status: "error",
      reason: "output truncated at 4096 tokens (raise aiMaxOutputTokens)",
      completionTokens: 4_096,
    })
    expect(parseCalls()).toBe(1)
  })

  test("reports max_tokens truncation when the core parser fails", async () => {
    const parseCalls = stubModelAndPrompt({ success: false, data: {}, error: "invalid JSON" })
    spyOn(LLM as any, "stream").mockImplementation(async () => ({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "finish-step",
            finishReason: "other",
            rawFinishReason: "max_tokens",
            usage: {},
          }
        },
      },
      text: Promise.resolve("["),
    }))

    const result = await runAiReview({
      files: [reviewFile(0)],
      grounding: [],
      allowSessionModel: true,
      maxOutputTokens: 6_144,
    })

    expect(result).toMatchObject({
      findings: [],
      status: "error",
      reason: "output truncated at 6144 tokens (raise aiMaxOutputTokens)",
    })
    expect(parseCalls()).toBe(1)
  })

  test("treats whitespace-only model output as an empty response", async () => {
    const parseCalls = stubModelAndPrompt()
    spyOn(LLM as any, "stream").mockImplementation(async () => ({
      fullStream: {
        async *[Symbol.asyncIterator]() {},
      },
      text: Promise.resolve(" \n\t "),
    }))

    const result = await runAiReview({ files: [reviewFile(0)], grounding: [], allowSessionModel: true })

    expect(result).toMatchObject({
      findings: [],
      status: "error",
      reason: "empty response",
      model: "test-provider/test-model",
    })
    expect(parseCalls()).toBe(0)
  })

  test("classifies typed provider model errors as an unconfigured model", async () => {
    spyOn(Provider as any, "defaultModel").mockImplementation(async () => ({
      providerID: "test-provider",
      modelID: "missing-model",
    }))
    spyOn(Provider as any, "getModel").mockRejectedValue(
      new Provider.ModelNotFoundError({
        providerID: "test-provider" as any,
        modelID: "missing-model" as any,
        suggestions: [],
      }),
    )
    spyOn(Dispatcher as any, "call").mockImplementation(async (method: string) => {
      if (method === "altimate_core.review_ai_prompt") return { data: { prompt: "Review the change." } }
      throw new Error(`unexpected dispatcher method: ${method}`)
    })
    const stream = spyOn(LLM as any, "stream")

    const result = await runAiReview({ files: [reviewFile(0)], grounding: [], allowSessionModel: true })

    expect(result).toMatchObject({ findings: [], status: "skipped", reason: NO_MODEL_REASON })
    expect(stream).not.toHaveBeenCalled()
  })

  test("returns timeout without parsing partial text when the signal aborts before the stream resolves", async () => {
    const parseCalls = stubModelAndPrompt()
    let fireTimeout: (() => void) | undefined
    let signal: AbortSignal | undefined
    spyOn(globalThis as any, "setTimeout").mockImplementation(((callback: () => void) => {
      fireTimeout = callback
      return 1
    }) as any)

    let resolveText: (value: string) => void = () => {}
    const text = new Promise<string>((resolve) => {
      resolveText = resolve
    })
    spyOn(LLM as any, "stream").mockImplementation(async (input: { abort: AbortSignal }) => {
      signal = input.abort
      return {
        fullStream: {
          async *[Symbol.asyncIterator]() {
            fireTimeout?.()
            resolveText('[{"file":"models/model_0.sql","title":"partial","body":"partial"}]')
          },
        },
        text,
      }
    })

    const result = await runAiReview({ files: [reviewFile(0)], grounding: [], allowSessionModel: true })

    expect(signal?.aborted).toBe(true)
    expect(result).toMatchObject({
      findings: [],
      status: "timeout",
      reason: "timed out after 124s (raise aiTimeoutSeconds / --ai-timeout)",
      model: "test-provider/test-model",
    })
    expect(parseCalls()).toBe(0)
  })

  test("returns timeout without reading text when fullStream stalls", async () => {
    const parseCalls = stubModelAndPrompt()
    let fireTimeout: (() => void) | undefined
    let textRead = false
    spyOn(globalThis as any, "setTimeout").mockImplementation(((callback: () => void) => {
      fireTimeout = callback
      return 1
    }) as any)

    spyOn(LLM as any, "stream").mockImplementation(async () => ({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield { type: "text-delta", text: "partial" }
          fireTimeout?.()
          await new Promise(() => {})
        },
      },
      get text() {
        textRead = true
        return Promise.resolve("[]")
      },
    }))

    const result = await runAiReview({ files: [reviewFile(0)], grounding: [], allowSessionModel: true })

    expect(result).toMatchObject({
      findings: [],
      status: "timeout",
      reason: "timed out after 124s (raise aiTimeoutSeconds / --ai-timeout)",
      model: "test-provider/test-model",
    })
    expect(textRead).toBe(false)
    expect(parseCalls()).toBe(0)
  })

  test("returns timeout without parsing when stream.text never settles after fullStream ends", async () => {
    const parseCalls = stubModelAndPrompt()
    let fireTimeout: (() => void) | undefined
    spyOn(globalThis as any, "setTimeout").mockImplementation(((callback: () => void) => {
      fireTimeout = callback
      return 1
    }) as any)

    spyOn(LLM as any, "stream").mockImplementation(async () => ({
      fullStream: {
        async *[Symbol.asyncIterator]() {},
      },
      get text() {
        fireTimeout?.()
        return new Promise<string>(() => {})
      },
    }))

    const result = await runAiReview({ files: [reviewFile(0)], grounding: [], allowSessionModel: true })

    expect(result).toMatchObject({
      findings: [],
      status: "timeout",
      reason: "timed out after 124s (raise aiTimeoutSeconds / --ai-timeout)",
      model: "test-provider/test-model",
    })
    expect(parseCalls()).toBe(0)
  })

  test("returns a sanitised error without parsing partial text when the stream emits an error event", async () => {
    const parseCalls = stubModelAndPrompt()
    spyOn(LLM as any, "stream").mockImplementation(async () => ({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield { type: "text-delta", text: "partial" }
          yield {
            type: "error",
            error: new Error(
              "upstream failed at https://provider.example/v1 using sk-abcdefghijklmnopqrstuvwxyz",
            ),
          }
        },
      },
      text: Promise.resolve('[{"file":"models/model_0.sql","title":"partial","body":"partial"}]'),
    }))

    const result = await runAiReview({ files: [reviewFile(0)], grounding: [], allowSessionModel: true })

    expect(result).toMatchObject({
      findings: [],
      status: "error",
      reason: "Error: upstream failed at <redacted-url> using sk-***",
      model: "test-provider/test-model",
    })
    expect(parseCalls()).toBe(0)
  })
})
