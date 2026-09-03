import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Dispatcher } from "@/altimate/native"
import { runAiReview, type AiReviewFile } from "@/altimate/review/ai-review"

afterEach(() => mock.restore())

function stubModelAndPrompt() {
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
      return { data: { findings: [] } }
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

describe("runAiReview stream handling", () => {
  test("returns timeout when pre-stream setup never resolves", async () => {
    spyOn(Dispatcher as any, "call").mockImplementation(
      (() => new Promise(() => {})) as any,
    )
    const stream = spyOn(LLM as any, "stream")

    const result = await runAiReview({ files: [reviewFile(0)], grounding: [], timeoutMs: 5 })

    expect(result).toEqual({ findings: [], status: "timeout", reason: "timed out after 0.005s" })
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
    spyOn(LLM as any, "stream").mockImplementation(async () => ({
      fullStream: {
        async *[Symbol.asyncIterator]() {},
      },
      text: Promise.resolve("[]"),
    }))

    const result = await runAiReview({
      files: Array.from({ length: 25 }, (_, index) => reviewFile(index)),
      grounding: [],
    })

    expect(result).toEqual({ findings: [], status: "ok" })
    expect(delays).toContain(100_000)
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

    const result = await runAiReview({ files: [reviewFile(0)], grounding: [] })

    expect(signal?.aborted).toBe(true)
    expect(result).toEqual({ findings: [], status: "timeout", reason: "timed out after 62s" })
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

    const result = await runAiReview({ files: [reviewFile(0)], grounding: [] })

    expect(result).toEqual({
      findings: [],
      status: "error",
      reason: "Error: upstream failed at <redacted-url> using sk-***",
    })
    expect(parseCalls()).toBe(0)
  })
})
