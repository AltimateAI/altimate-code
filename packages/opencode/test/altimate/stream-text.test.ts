// altimate_change start — preserve provider errors when reading auxiliary LLM streams
import { describe, expect, test } from "bun:test"
import { APICallError, streamText } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import { readStreamText } from "../../src/altimate/llm/stream-text"

describe("readStreamText", () => {
  test("drains the stream before resolving its text", async () => {
    let drained = false
    let resolve!: (value: string) => void
    const text = new Promise<string>((done) => {
      resolve = done
    })
    const result = await readStreamText({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "hello" }
        drained = true
        resolve("hello")
      })(),
      text,
    })
    expect(result).toBe("hello")
    expect(drained).toBe(true)
  })

  test("preserves the original provider error and status over NoOutputGeneratedError", async () => {
    const error = Object.assign(new Error("Unsupported parameter: thinkingBudget"), { statusCode: 400 })
    const result = readStreamText({
      fullStream: (async function* () {
        yield { type: "error", error }
      })(),
      text: Promise.reject(new Error("NoOutputGeneratedError: No output generated")),
    })
    expect(await result.catch((caught) => caught)).toBe(error)
  })

  test("preserves a real SDK provider 400 without retrying it", async () => {
    const error = new APICallError({
      message: "Unsupported parameter: thinkingBudget",
      statusCode: 400,
      url: "https://provider.test/generate",
      requestBodyValues: {},
      isRetryable: false,
    })
    let calls = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls++
        throw error
      },
    })
    const stream = streamText({ model, prompt: "label text", maxRetries: 2, onError: () => {} })
    expect(await readStreamText(stream).catch((caught) => caught)).toBe(error)
    expect(calls).toBe(1)
  })

  test("rejects instead of returning partial text after a stream error", async () => {
    const error = new Error("connection interrupted")
    const result = readStreamText({
      fullStream: (async function* () {
        yield { type: "text-delta", text: "partial" }
        yield { type: "error", error }
      })(),
      text: Promise.resolve("partial"),
    })
    expect(await result.catch((caught) => caught)).toBe(error)
  })

  test("preserves errors thrown while iterating", async () => {
    const error = new Error("connection failed")
    const result = readStreamText({
      fullStream: (async function* () {
        throw error
      })(),
      text: Promise.resolve(""),
    })
    expect(await result.catch((caught) => caught)).toBe(error)
  })

  test("preserves text rejection when no stream error was emitted", async () => {
    const error = new Error("No output generated")
    const result = readStreamText({
      fullStream: (async function* () {})(),
      text: Promise.reject(error),
    })
    expect(await result.catch((caught) => caught)).toBe(error)
  })
})
// altimate_change end
