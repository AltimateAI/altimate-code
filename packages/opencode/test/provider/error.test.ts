import { describe, test, expect } from "bun:test"
import { ProviderError } from "../../src/provider/error"
import { APICallError } from "ai"

// Helper to construct APICallError instances for testing.
// APICallError is from the Vercel AI SDK and wraps HTTP errors from LLM providers.
function makeAPICallError(opts: {
  message?: string
  statusCode?: number
  responseBody?: string
  isRetryable?: boolean
  url?: string
  responseHeaders?: Record<string, string>
}): APICallError {
  return new APICallError({
    message: opts.message ?? "",
    statusCode: opts.statusCode,
    responseBody: opts.responseBody,
    isRetryable: opts.isRetryable ?? false,
    url: opts.url,
    responseHeaders: opts.responseHeaders,
    requestBodyValues: {},
  })
}

// ---------------------------------------------------------------------------
// parseStreamError — classifies SSE streaming errors from providers
// ---------------------------------------------------------------------------
describe("ProviderError.parseStreamError: SSE error classification", () => {
  test("classifies context_length_exceeded as context_overflow", () => {
    const result = ProviderError.parseStreamError({
      type: "error",
      error: { code: "context_length_exceeded", message: "too long" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("context_overflow")
  })

  test("classifies usage_not_included with upgrade URL", () => {
    const result = ProviderError.parseStreamError({
      type: "error",
      error: { code: "usage_not_included", message: "not available" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("api_error")
    if (result!.type === "api_error") {
      expect(result!.message).toContain("chatgpt.com/explore/plus")
    }
  })

  test("classifies invalid_prompt with passthrough message", () => {
    const result = ProviderError.parseStreamError({
      type: "error",
      error: { code: "invalid_prompt", message: "Your prompt contains disallowed content" },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("api_error")
    if (result!.type === "api_error") {
      expect(result!.message).toBe("Your prompt contains disallowed content")
    }
  })

  test("invalid_prompt falls back to default when message is not a string", () => {
    const result = ProviderError.parseStreamError({
      type: "error",
      error: { code: "invalid_prompt", message: 42 },
    })
    expect(result).toBeDefined()
    expect(result!.type).toBe("api_error")
    if (result!.type === "api_error") {
      expect(result!.message).toBe("Invalid prompt.")
    }
  })

  test("returns undefined for non-error events", () => {
    expect(ProviderError.parseStreamError({ type: "content", text: "hello" })).toBeUndefined()
  })

  test("returns undefined for unknown error codes", () => {
    expect(
      ProviderError.parseStreamError({
        type: "error",
        error: { code: "unknown_code", message: "weird" },
      }),
    ).toBeUndefined()
  })

  test("returns undefined for null/undefined input", () => {
    expect(ProviderError.parseStreamError(null)).toBeUndefined()
    expect(ProviderError.parseStreamError(undefined)).toBeUndefined()
  })

  test("parses JSON string input (AI SDK sometimes passes SSE chunks as strings)", () => {
    const jsonStr = JSON.stringify({
      type: "error",
      error: { code: "context_length_exceeded" },
    })
    const result = ProviderError.parseStreamError(jsonStr)
    expect(result).toBeDefined()
    expect(result!.type).toBe("context_overflow")

    // Non-JSON strings return undefined
    expect(ProviderError.parseStreamError("not valid json")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseAPICallError — classifies HTTP errors from LLM provider APIs.
// Overflow detection does NOT depend on providerID; it uses regex matching
// on the error message. providerID only affects retry logic.
// ---------------------------------------------------------------------------
describe("ProviderError.parseAPICallError: overflow detection", () => {
  test("detects 'prompt is too long' pattern (Anthropic)", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "anthropic" as any,
      error: makeAPICallError({
        message: "prompt is too long: 200000 tokens > 100000 maximum",
        statusCode: 400,
      }),
    })
    expect(result.type).toBe("context_overflow")
  })

  test("detects 'exceeds the context window' pattern (OpenAI)", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "This request exceeds the context window for gpt-4o",
        statusCode: 400,
      }),
    })
    expect(result.type).toBe("context_overflow")
  })

  test("detects HTTP 413 as overflow regardless of message text", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "anthropic" as any,
      error: makeAPICallError({
        message: "something completely unrelated",
        statusCode: 413,
      }),
    })
    expect(result.type).toBe("context_overflow")
  })

  test("detects '400 (no body)' and '413 (no body)' patterns (Cerebras/Mistral)", () => {
    for (const msg of ["400 (no body)", "413 (no body)", "400 status code (no body)"]) {
      const result = ProviderError.parseAPICallError({
        providerID: "cerebras" as any,
        error: makeAPICallError({ message: msg, statusCode: 400 }),
      })
      expect(result.type).toBe("context_overflow")
    }
  })
})

describe("ProviderError.parseAPICallError: error message extraction", () => {
  test("OpenAI 404 is treated as retryable (model may be temporarily unavailable)", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Model not found",
        statusCode: 404,
        isRetryable: false, // SDK says not retryable, but our code overrides
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.isRetryable).toBe(true)
    }
  })

  test("non-OpenAI providers pass through isRetryable from SDK", () => {
    const retriable = ProviderError.parseAPICallError({
      providerID: "anthropic" as any,
      error: makeAPICallError({
        message: "Internal server error",
        statusCode: 500,
        isRetryable: true,
      }),
    })
    expect(retriable.type).toBe("api_error")
    if (retriable.type === "api_error") expect(retriable.isRetryable).toBe(true)

    const nonRetriable = ProviderError.parseAPICallError({
      providerID: "anthropic" as any,
      error: makeAPICallError({
        message: "Bad request",
        statusCode: 400,
        isRetryable: false,
      }),
    })
    expect(nonRetriable.type).toBe("api_error")
    if (nonRetriable.type === "api_error") expect(nonRetriable.isRetryable).toBe(false)
  })

  test("HTML 403 response yields human-readable gateway message", () => {
    // When the SDK provides a message AND the response body is HTML,
    // the code detects the HTML and returns a friendly message instead of raw markup.
    const result = ProviderError.parseAPICallError({
      providerID: "anthropic" as any,
      error: makeAPICallError({
        message: "Forbidden",
        statusCode: 403,
        responseBody: "<html><body>Forbidden</body></html>",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("Forbidden")
      expect(result.message).toContain("gateway or proxy")
    }
  })

  test("preserves URL in metadata when present", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "anthropic" as any,
      error: makeAPICallError({
        message: "Bad request",
        statusCode: 400,
        url: "https://api.anthropic.com/v1/messages",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.metadata?.url).toBe("https://api.anthropic.com/v1/messages")
    }
  })

  test("falls back to HTTP status text when message is empty and no body", () => {
    // Many providers send empty messages on rate-limiting (429);
    // the code falls back to Node's STATUS_CODES lookup.
    const result = ProviderError.parseAPICallError({
      providerID: "anthropic" as any,
      error: makeAPICallError({
        message: "",
        statusCode: 429,
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toBe("Too Many Requests")
    }
  })

  test("appends plain-text responseBody to message", () => {
    // When responseBody is not JSON and not HTML, it's appended to the status message
    const result = ProviderError.parseAPICallError({
      providerID: "anthropic" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: "invalid JSON in request body at position 42",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("Bad Request")
      expect(result.message).toContain("invalid JSON in request body")
    }
  })
})
