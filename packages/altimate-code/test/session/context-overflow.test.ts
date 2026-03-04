import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { MessageV2 } from "../../src/session/message-v2"

describe("session.context-overflow", () => {
  // ─── ContextOverflowError.isInstance ────────────────────────────────

  describe("ContextOverflowError.isInstance", () => {
    test("returns true for context overflow error objects", () => {
      const error = {
        name: "ContextOverflowError",
        data: {
          message: "Input exceeds context window of this model",
          responseBody: "{}",
        },
      }
      expect(MessageV2.ContextOverflowError.isInstance(error)).toBe(true)
    })

    test("returns true for ContextOverflowError created via constructor", () => {
      const error = new MessageV2.ContextOverflowError({
        message: "Input exceeds context window of this model",
      })
      const obj = error.toObject()
      expect(MessageV2.ContextOverflowError.isInstance(obj)).toBe(true)
    })

    test("returns false for APIError objects", () => {
      const error = {
        name: "APIError",
        data: { message: "Rate limit exceeded", isRetryable: true },
      }
      expect(MessageV2.ContextOverflowError.isInstance(error)).toBe(false)
    })

    test("returns false for AbortedError", () => {
      const error = new MessageV2.AbortedError({ message: "aborted" })
      expect(MessageV2.ContextOverflowError.isInstance(error.toObject())).toBe(false)
    })

    test("returns false for UnknownError", () => {
      const error = { name: "UnknownError", data: { message: "something went wrong" } }
      expect(MessageV2.ContextOverflowError.isInstance(error)).toBe(false)
    })

    test("returns false for non-object values", () => {
      expect(MessageV2.ContextOverflowError.isInstance("string")).toBe(false)
      expect(MessageV2.ContextOverflowError.isInstance(42)).toBe(false)
      expect(MessageV2.ContextOverflowError.isInstance(undefined)).toBe(false)
      expect(MessageV2.ContextOverflowError.isInstance(true)).toBe(false)
    })

    test("returns false for null input", () => {
      expect(MessageV2.ContextOverflowError.isInstance(null)).toBe(false)
    })

    test("returns false for empty object", () => {
      expect(MessageV2.ContextOverflowError.isInstance({})).toBe(false)
    })

    // NOTE: isInstance only checks `name` field, not `data` shape.
    // An object with just { name: "ContextOverflowError" } passes.
    test("returns true for object with matching name but no data (isInstance only checks name)", () => {
      expect(MessageV2.ContextOverflowError.isInstance({ name: "ContextOverflowError" })).toBe(true)
    })
  })

  // ─── fromError: stream error detection ──────────────────────────────

  describe("fromError stream error detection", () => {
    test("stream error with context_length_exceeded code", () => {
      const input = { type: "error", error: { code: "context_length_exceeded" } }
      const result = MessageV2.fromError(input, { providerID: "test" })
      expect(result.name).toBe("ContextOverflowError")
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })

    test("non-overflow error code does not produce ContextOverflowError", () => {
      const input = { type: "error", error: { code: "insufficient_quota" } }
      const result = MessageV2.fromError(input, { providerID: "test" })
      expect(result.name).not.toBe("ContextOverflowError")
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(false)
    })

    test("stream error as JSON string is parsed correctly", () => {
      const input = JSON.stringify({ type: "error", error: { code: "context_length_exceeded" } })
      const result = MessageV2.fromError(input, { providerID: "test" })
      // fromError should handle the JSON string
      expect(result).toBeDefined()
    })
  })

  // ─── fromError: APICallError provider patterns ──────────────────────
  // These test all the overflow detection patterns from provider/error.ts

  describe("fromError detects context overflow from APICallError messages", () => {
    function makeAPICallError(message: string, statusCode = 400) {
      return new APICallError({
        message,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      })
    }

    // Anthropic
    test("detects Anthropic overflow: prompt is too long", () => {
      const result = MessageV2.fromError(
        makeAPICallError("prompt is too long: 213462 tokens > 200000 maximum"),
        { providerID: "anthropic" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })

    // OpenAI
    test("detects OpenAI overflow: exceeds the context window", () => {
      const result = MessageV2.fromError(
        makeAPICallError("Your input exceeds the context window of this model"),
        { providerID: "openai" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })

    // Google Gemini
    test("detects Gemini overflow: input token count exceeds maximum", () => {
      const result = MessageV2.fromError(
        makeAPICallError("The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"),
        { providerID: "google" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })

    // Groq
    test("detects Groq overflow: reduce the length", () => {
      const result = MessageV2.fromError(
        makeAPICallError("Please reduce the length of the messages or completion"),
        { providerID: "groq" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })

    // Cerebras/Mistral 400 no body
    test("detects 400 no body as overflow", () => {
      const result = MessageV2.fromError(
        makeAPICallError("400 status code (no body)"),
        { providerID: "cerebras" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })

    // 413 no body
    test("detects 413 no body as overflow", () => {
      const result = MessageV2.fromError(
        makeAPICallError("413 status code (no body)", 413),
        { providerID: "mistral" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })

    // Amazon Bedrock
    test("detects Bedrock overflow: input is too long", () => {
      const result = MessageV2.fromError(
        makeAPICallError("input is too long for requested model"),
        { providerID: "bedrock" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })

    // OpenRouter / DeepSeek
    test("detects OpenRouter overflow: maximum context length", () => {
      const result = MessageV2.fromError(
        makeAPICallError("maximum context length is 128000 tokens"),
        { providerID: "openrouter" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })

    // Azure OpenAI
    test("detects Azure OpenAI overflow: the request was too long", () => {
      const result = MessageV2.fromError(
        makeAPICallError("The request was too long"),
        { providerID: "openai" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })

    test("detects Azure OpenAI overflow: maximum tokens for requested operation", () => {
      const result = MessageV2.fromError(
        makeAPICallError("maximum tokens for requested operation exceeded"),
        { providerID: "openai" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })

    // ─── Negative cases ───────────────────────────────────────────────

    test("does not classify 429 as context overflow", () => {
      const result = MessageV2.fromError(
        makeAPICallError("429 status code (no body)", 429),
        { providerID: "test" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(false)
    })

    test("does not classify rate limit error as overflow", () => {
      const result = MessageV2.fromError(
        makeAPICallError("Rate limit exceeded. Please retry after 30 seconds.", 429),
        { providerID: "test" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(false)
    })

    test("does not classify authentication error as overflow", () => {
      const result = MessageV2.fromError(
        makeAPICallError("Invalid API key", 401),
        { providerID: "test" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(false)
    })

    test("does not classify server error as overflow", () => {
      const result = MessageV2.fromError(
        makeAPICallError("Internal server error", 500),
        { providerID: "test" },
      )
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(false)
    })
  })

  // ─── fromError: edge cases ──────────────────────────────────────────

  describe("fromError edge cases", () => {
    test("handles null error input gracefully", () => {
      const result = MessageV2.fromError(null, { providerID: "test" })
      expect(result).toBeDefined()
      expect(result.name).toBe("UnknownError")
    })

    test("handles undefined error input", () => {
      const result = MessageV2.fromError(undefined, { providerID: "test" })
      expect(result).toBeDefined()
      expect(result.name).toBe("UnknownError")
    })

    test("handles numeric error input", () => {
      const result = MessageV2.fromError(123, { providerID: "test" })
      expect(result).toBeDefined()
      expect(result.name).toBe("UnknownError")
    })

    test("handles string error input", () => {
      const result = MessageV2.fromError("something broke", { providerID: "test" })
      expect(result).toBeDefined()
    })

    test("handles Error object with no stack", () => {
      const error = new Error("test error")
      error.stack = undefined
      const result = MessageV2.fromError(error, { providerID: "test" })
      expect(result).toBeDefined()
    })

    test("handles error with empty message", () => {
      const result = MessageV2.fromError(new Error(""), { providerID: "test" })
      expect(result).toBeDefined()
    })

    test("handles deeply nested error objects", () => {
      const error = { type: "error", error: { code: "unknown", nested: { deep: { value: true } } } }
      const result = MessageV2.fromError(error, { providerID: "test" })
      expect(result).toBeDefined()
    })
  })
})
