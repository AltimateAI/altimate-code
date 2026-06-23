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
    url: opts.url ?? "",
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

  test("falls back to api_error with extracted message for unknown error codes (v0.7.1+)", () => {
    // Behavior change in v0.7.1: previously returned undefined, which caused the
    // caller to fall through to JSON.stringify(e). Now extracts the message via
    // the same string-typeof chain used in parseAPICallError so users see a
    // clean api_error instead of `Unknown: {"type":"error",...}`.
    const result = ProviderError.parseStreamError({
      type: "error",
      error: { code: "unknown_code", message: "weird" },
    })
    expect(result?.type).toBe("api_error")
    if (result && result.type === "api_error") {
      expect(result.message).toBe("weird")
      expect(result.isRetryable).toBe(false)
    }
  })

  test("returns undefined when no extractable message exists for unknown code", () => {
    // Last-resort behavior: extractor finds no string anywhere — caller falls
    // back to JSON.stringify(e), which is at least visible if not friendly.
    expect(
      ProviderError.parseStreamError({
        type: "error",
        error: { code: "unknown_code" },
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

  test("extracts nested error.message from OpenAI-shaped JSON body", () => {
    // OpenAI returns 4xx errors with {error: {message, type, code}}. The extractor
    // must reach body.error.message — not stop at body.error (which is the object).
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({
          error: {
            message: "The model `gpt-5-codex` does not exist or you do not have access to it.",
            type: "invalid_request_error",
            code: "model_not_found",
          },
        }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("Bad Request")
      expect(result.message).toContain("gpt-5-codex")
      expect(result.message).toContain("does not exist")
      // The raw structured body must not be dumped when a clean message extracted.
      // Detect a leak by looking for JSON delimiters from the parsed body.
      expect(result.message).not.toContain('"error":')
      expect(result.message).not.toContain("{")
    }
  })

  test("extracts top-level message field when present", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "anthropic" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({ message: "Field 'foo' is required" }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("Field 'foo' is required")
    }
  })

  test("falls back to body.error string when it is a plain string", () => {
    // Some providers return {error: "string"} rather than {error: {message: ...}}.
    const result = ProviderError.parseAPICallError({
      providerID: "anthropic" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({ error: "Something went wrong" }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("Something went wrong")
    }
  })

  test("falls back through the chain when body.error has no message but body.message does", () => {
    // body.error is an object without a `message` key — the extractor must skip it
    // and reach the top-level body.message.
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { code: "rate_limited", type: "throttle" },
          message: "Slow down",
        }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("Slow down")
    }
  })

  test("non-string body.error.message does not block a valid body.message", () => {
    // Same class as the bug we just fixed: a truthy non-string at any level of the
    // chain must not short-circuit a valid string further down.
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { message: ["array", "of", "strings"] },
          message: "Real human-readable error",
        }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("Real human-readable error")
      expect(result.message).not.toContain("array")
    }
  })

  test("dumps raw body when no string-typed message field exists anywhere", () => {
    // body.error has only non-message fields and no top-level message — the parser
    // falls through to the raw responseBody dump (last-resort behavior preserved).
    const responseBody = JSON.stringify({ error: { code: "x", type: "y" } })
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody,
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      // Falls through to `${msg}: ${responseBody}` — preserves existing behavior.
      expect(result.message).toContain("Bad Request")
      expect(result.message).toContain(responseBody)
    }
  })
})
