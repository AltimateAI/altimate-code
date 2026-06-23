/**
 * Adversarial tests for v0.7.1 release.
 *
 * Release content:
 *   1. ProviderError.parseAPICallError — extract OpenAI nested error.message
 *      instead of dumping raw body when typeof guard rejects body.error
 *      (#789, closes #788)
 *
 * Focus here is the surface a chaos engineer / provider-spec abuser would
 * actually throw at parseAPICallError post-fix: malformed JSON shapes,
 * boundary scalar-typed bodies, prototype-pollution attempts, and very large
 * error strings. The original fix's regression-guard tests live in
 * test/provider/error.test.ts; this file pins the edges they don't cover.
 */

import { describe, test, expect } from "bun:test"
import { ProviderError } from "../../src/provider/error"
import { Telemetry } from "../../src/altimate/telemetry"
import { APICallError } from "ai"

function makeAPICallError(opts: {
  message?: string
  statusCode?: number
  responseBody?: string
  url?: string
}): APICallError {
  return new APICallError({
    message: opts.message ?? "",
    statusCode: opts.statusCode,
    responseBody: opts.responseBody,
    isRetryable: false,
    url: opts.url ?? "",
    requestBodyValues: {},
  })
}

// ---------------------------------------------------------------------------
// Boundary — scalar / null / array bodies that JSON.parse can produce
// ---------------------------------------------------------------------------

describe("parseAPICallError — JSON-scalar and non-object bodies", () => {
  test("body parses to null — does not crash, falls through to raw body dump", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: "null",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      // Optional chaining on null returns undefined for body.error?.message
      // and reading body.message / body.error on null throws — the try/catch
      // around JSON.parse + the extraction must absorb that and fall through.
      expect(result.message).toContain("Bad Request")
    }
  })

  test("body parses to a number scalar — does not crash", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: "42",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("Bad Request")
    }
  })

  test("body parses to a string scalar — does not crash", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: '"a plain string"',
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("Bad Request")
    }
  })

  test("body parses to an array — does not crash, no value extracted", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: '[{"error":{"message":"buried"}}]',
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      // Array.error is undefined — extractor finds nothing, falls back to raw.
      expect(result.message).toContain("Bad Request")
    }
  })
})

// ---------------------------------------------------------------------------
// Prototype-pollution attempt — must not pollute Object.prototype
// ---------------------------------------------------------------------------

describe("parseAPICallError — prototype pollution attempts", () => {
  test("__proto__ in body does not pollute Object.prototype", () => {
    // Important: write the JSON as a literal string. `JSON.stringify({__proto__: ...})`
    // produces `{}` because in object-literal syntax `__proto__` is the prototype
    // setter (it sets [[Prototype]]) rather than an own enumerable property, and
    // JSON.stringify only walks own enumerables. Building the JSON by hand puts
    // the malicious key on the wire so JSON.parse in parseAPICallError actually
    // sees it — which is the surface a hostile gateway would exploit.
    // try/finally so a regression doesn't leak prototype pollution into the
    // rest of the suite (cascading-failure containment).
    const before = (Object.prototype as any).polluted
    try {
      ProviderError.parseAPICallError({
        providerID: "openai" as any,
        error: makeAPICallError({
          message: "Bad Request",
          statusCode: 400,
          responseBody: '{"__proto__":{"polluted":"yes"},"error":{"message":"harmless surface"}}',
        }),
      })
      expect((Object.prototype as any).polluted).toBe(before)
      // Modern V8 makes __proto__ a regular property post-JSON.parse since 2019,
      // but if a future refactor ever switches to Object.assign / spread we want
      // a regression guard.
    } finally {
      if (before === undefined) delete (Object.prototype as any).polluted
      else (Object.prototype as any).polluted = before
    }
  })

  test("constructor.prototype injection does not pollute", () => {
    const before = (Object.prototype as any).injected
    try {
      ProviderError.parseAPICallError({
        providerID: "openai" as any,
        error: makeAPICallError({
          message: "Bad Request",
          statusCode: 400,
          responseBody: JSON.stringify({
            constructor: { prototype: { injected: "yes" } },
            error: { message: "harmless" },
          }),
        }),
      })
      expect((Object.prototype as any).injected).toBe(before)
    } finally {
      if (before === undefined) delete (Object.prototype as any).injected
      else (Object.prototype as any).injected = before
    }
  })
})

// ---------------------------------------------------------------------------
// Large strings — extractor returns input as-is, no truncation expected here
// (consumers handle truncation), but it must not crash.
// ---------------------------------------------------------------------------

describe("parseAPICallError — large message bodies", () => {
  test("100KB error.message is returned without crashing", () => {
    const huge = "x".repeat(100_000)
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({ error: { message: huge } }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message.length).toBeGreaterThan(99_000)
      expect(result.message.startsWith("Bad Request:")).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Malformed JSON — parser must absorb and fall back to status text or body
// ---------------------------------------------------------------------------

describe("parseAPICallError — malformed JSON bodies", () => {
  test("unparseable JSON does not crash, falls through to raw body append", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: '{"error": {"message": "unterminated',
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("Bad Request")
    }
  })

  test("empty-string body — falls back to raw (which is empty), preserves status", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: "",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toBe("Bad Request")
    }
  })
})

// ---------------------------------------------------------------------------
// Type-confusion ladder — null at any tier of the OR chain must not crash
// ---------------------------------------------------------------------------

describe("parseAPICallError — null and missing fields at every tier", () => {
  test("body.error explicitly null — falls through to body.message", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({ error: null, message: "fallback" }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("fallback")
    }
  })

  test("body.error.message explicitly null — falls through to body.message", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { message: null, code: "x" },
          message: "fallback",
        }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("fallback")
    }
  })

  test("body.error.message numeric — falls through to body.message", () => {
    // typeof 42 === "number", not "string" — must not assign to errMsg.
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { message: 42 },
          message: "fallback",
        }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("fallback")
      expect(result.message).not.toContain("42")
    }
  })
})

// ---------------------------------------------------------------------------
// Fix A — Bedrock / AWS Lambda errorMessage shape
// ---------------------------------------------------------------------------

describe("parseAPICallError — body.errorMessage extraction (Bedrock/Lambda)", () => {
  test("extracts body.errorMessage when no error.message or top-level message", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "amazon-bedrock" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({
          errorMessage: "ValidationException: model ID is required",
          errorType: "ValidationException",
        }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("ValidationException: model ID is required")
    }
  })

  test("body.error.message wins over body.errorMessage when both present", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "amazon-bedrock" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { message: "nested wins" },
          errorMessage: "lambda style",
        }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("nested wins")
      expect(result.message).not.toContain("lambda style")
    }
  })
})

// ---------------------------------------------------------------------------
// Fix C — parseStreamError fallback for non-OpenAI codes
// ---------------------------------------------------------------------------

describe("parseStreamError — fallback for codes not in the switch", () => {
  test("unknown code with body.error.message returns api_error, not undefined", () => {
    const result = ProviderError.parseStreamError({
      type: "error",
      error: { code: "anthropic_overloaded", message: "Provider is overloaded, try again." },
    })
    expect(result).toBeDefined()
    expect(result?.type).toBe("api_error")
    if (result && result.type === "api_error") {
      expect(result.message).toBe("Provider is overloaded, try again.")
      expect(result.isRetryable).toBe(false)
    }
  })

  test("unknown code with no extractable string returns undefined", () => {
    // Last-resort behavior: caller falls back to JSON.stringify(e).
    const result = ProviderError.parseStreamError({
      type: "error",
      error: { code: "weird_code" },
    })
    expect(result).toBeUndefined()
  })

  test("unknown code with body.errorMessage (Bedrock-style) returns api_error", () => {
    const result = ProviderError.parseStreamError({
      type: "error",
      errorMessage: "ValidationException from streaming endpoint",
    })
    expect(result).toBeDefined()
    if (result && result.type === "api_error") {
      expect(result.message).toContain("ValidationException")
    }
  })

  test("documented OpenAI codes still hit the switch (regression guard)", () => {
    const result = ProviderError.parseStreamError({
      type: "error",
      error: { code: "insufficient_quota", message: "ignored" },
    })
    expect(result?.type).toBe("api_error")
    if (result && result.type === "api_error") {
      // Pre-existing literal — switch must take precedence over fallback.
      expect(result.message).toContain("Quota exceeded")
    }
  })
})

// ---------------------------------------------------------------------------
// Fix D — /models hint on model_not_found
// ---------------------------------------------------------------------------

describe("parseAPICallError — /models hint on model_not_found", () => {
  test("appends `altimate-code models` hint when error.code === model_not_found", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({
          error: {
            message: "The model 'gpt-99' does not exist or you do not have access to it.",
            type: "invalid_request_error",
            code: "model_not_found",
          },
        }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).toContain("does not exist")
      // Pin the canonical hint text exactly so docs / changelog / code can't
      // diverge silently. This string is the single source of truth.
      expect(result.message).toContain("Run `altimate models` to see available models.")
    }
  })

  test("does NOT append hint when error.code is something else", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { message: "Invalid request", code: "invalid_request_error" },
        }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.message).not.toContain("altimate models")
    }
  })
})

// ---------------------------------------------------------------------------
// Fix E — model_not_found is not retryable (carve-out from OpenAI 404 logic)
// ---------------------------------------------------------------------------

describe("parseAPICallError — model_not_found skips retry-storm", () => {
  test("OpenAI 404 with code=model_not_found has isRetryable=false", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Not Found",
        statusCode: 404,
        responseBody: JSON.stringify({
          error: { message: "model gone", code: "model_not_found" },
        }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.isRetryable).toBe(false)
    }
  })

  test("OpenAI 404 without model_not_found preserves retryable=true (regression guard)", () => {
    // Existing behavior: OpenAI 404 is force-retried for transient model availability blips.
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Not Found",
        statusCode: 404,
        responseBody: JSON.stringify({
          error: { message: "transient", code: "service_unavailable" },
        }),
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.isRetryable).toBe(true)
    }
  })

  test("malformed body on 404 falls back to retryable=true (preserves transient-blip handling)", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Not Found",
        statusCode: 404,
        responseBody: "{not valid json",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.isRetryable).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Fix G — responseBody capped at 4KB
// ---------------------------------------------------------------------------

describe("parseAPICallError — responseBody cap", () => {
  test("100KB responseBody is truncated to exactly 4096 chars + truncation marker", () => {
    const huge = "a".repeat(100_000)
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: huge,
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      // Pin the boundary EXACTLY. A regression from 4096 → e.g. 8192 would
      // still pass `toBeLessThan(5000)` for shorter bodies; pin the prefix
      // length and the appended marker so the cap is the load-bearing
      // assertion, not the upper bound.
      const prefix = "a".repeat(4096)
      expect(result.responseBody).toBe(`${prefix}…[truncated 95904 chars]`)
    }
  })

  test("small responseBody passes through untouched", () => {
    const small = "small body"
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: small,
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.responseBody).toBe(small)
    }
  })
})

// ---------------------------------------------------------------------------
// Fix H — metadata.url internal-host masking
// ---------------------------------------------------------------------------

describe("parseAPICallError — metadata.url masking for internal hosts", () => {
  test("public provider URL is preserved verbatim", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "https://api.openai.com/v1/chat/completions",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.metadata?.url).toBe("https://api.openai.com/v1/chat/completions")
    }
  })

  test(".internal hostname is redacted", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "https://llm-gateway.bigbank.internal/v1/chat",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.metadata?.url).not.toContain("bigbank.internal")
      expect(result.metadata?.url).toContain("internal-host.redacted")
    }
  })

  test("RFC1918 10.x IP host is redacted", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "http://10.20.30.40:8080/v1/chat",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.metadata?.url).not.toContain("10.20.30.40")
      expect(result.metadata?.url).toContain("internal-host.redacted")
    }
  })

  test("malformed URL falls back to verbatim (does not crash)", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "not a url",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.metadata?.url).toBe("not a url")
    }
  })

  test("internal URL with basic-auth userinfo redacts BOTH host and credentials", () => {
    // Regression guard: u.toString() preserves u.username/u.password by default,
    // so naively rewriting only u.hostname leaks a basic-auth password through
    // metadata.url. Must clear both before serializing.
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "https://admin:hunter2@10.20.30.40/secret",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.metadata?.url).not.toContain("hunter2")
      expect(result.metadata?.url).not.toContain("admin:")
      expect(result.metadata?.url).not.toContain("10.20.30.40")
      expect(result.metadata?.url).toContain("internal-host.redacted")
    }
  })

  test("IPv6 loopback host is redacted", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "http://[::1]:8080/admin",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.metadata?.url).toContain("internal-host.redacted")
    }
  })

  test("IPv6 ULA (fc00::/7) host is redacted", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "http://[fc00::1]/v1",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.metadata?.url).toContain("internal-host.redacted")
    }
  })

  test("AWS IMDS endpoint (169.254.169.254) is redacted", () => {
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "http://169.254.169.254/latest/meta-data/",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.metadata?.url).not.toContain("169.254.169.254")
      expect(result.metadata?.url).toContain("internal-host.redacted")
    }
  })

  test("RFC1918 boundary: 172.15 (NOT private) and 172.32 (NOT private) preserved", () => {
    const a = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "http://172.15.0.1/v1",
      }),
    })
    if (a.type === "api_error") expect(a.metadata?.url).toContain("172.15.0.1")

    const b = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "http://172.32.0.1/v1",
      }),
    })
    if (b.type === "api_error") expect(b.metadata?.url).toContain("172.32.0.1")
  })

  test("lookalike hostname `attacker-localhost.com` is NOT redacted", () => {
    // Defends against substring-match regression — must use boundary check.
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "https://attacker-localhost.com/exfil",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.metadata?.url).toBe("https://attacker-localhost.com/exfil")
    }
  })

  test("basic-auth userinfo on a PUBLIC host is also stripped", () => {
    // Pre cubic-bot review: userinfo was only cleared for internal hosts.
    // Credentials in a public URL are arguably more dangerous (they're real
    // keys, not just a misconfigured gateway), so userinfo strip runs
    // regardless of internal/public classification.
    const result = ProviderError.parseAPICallError({
      providerID: "openai" as any,
      error: makeAPICallError({
        message: "Bad Request",
        statusCode: 400,
        url: "https://user:hunter2@api.openai.com/v1/chat",
      }),
    })
    expect(result.type).toBe("api_error")
    if (result.type === "api_error") {
      expect(result.metadata?.url).not.toContain("hunter2")
      expect(result.metadata?.url).not.toContain("user:")
      // Public host preserved; only userinfo redacted.
      expect(result.metadata?.url).toContain("api.openai.com")
    }
  })
})

// ---------------------------------------------------------------------------
// Fix F — maskString email + internal-host masking
// ---------------------------------------------------------------------------

describe("Telemetry.maskString — email and internal-host patterns", () => {
  test("email addresses are masked to <email>", () => {
    const out = Telemetry.maskString("user@bigbank.com is not authorized")
    expect(out).not.toContain("user@bigbank.com")
    expect(out).toContain("<email>")
  })

  test("internal .local hostname URL is masked", () => {
    const out = Telemetry.maskString("Cannot reach https://llm-gw.fortune500.local/v1/chat")
    expect(out).not.toContain("fortune500.local")
    expect(out).toContain("<internal-host>")
  })

  test("RFC1918 10.x URL is masked", () => {
    const out = Telemetry.maskString("Connection refused at http://10.20.30.40:8080/v1")
    expect(out).not.toContain("10.20.30.40")
    expect(out).toContain("<internal-host>")
  })

  test("public URL is left alone", () => {
    const out = Telemetry.maskString("https://api.openai.com/v1/chat returned 500")
    expect(out).toContain("api.openai.com")
  })

  test("api key still masked (regression guard)", () => {
    const out = Telemetry.maskString("Auth failed with sk-abcdefghij1234567890XX")
    expect(out).not.toContain("sk-abcdefghij1234567890XX")
    expect(out).toContain("sk-***")
  })

  test("AWS IMDS URL (169.254.169.254) is masked", () => {
    const out = Telemetry.maskString("Cannot reach http://169.254.169.254/latest/meta-data/")
    expect(out).not.toContain("169.254.169.254")
    expect(out).toContain("<internal-host>")
  })

  test("IPv6 loopback URL is masked", () => {
    const out = Telemetry.maskString("Connection refused at http://[::1]:8080/admin")
    expect(out).not.toContain("[::1]")
    expect(out).toContain("<internal-host>")
  })

  test("IPv6 ULA (fc00::) URL is masked", () => {
    const out = Telemetry.maskString("Backend down: http://[fc00::1]/v1")
    expect(out).not.toContain("fc00")
    expect(out).toContain("<internal-host>")
  })

  test("IPv6 link-local (fe80::) URL is masked", () => {
    const out = Telemetry.maskString("Probe failed http://[fe80::1%25eth0]/x")
    expect(out).not.toContain("fe80")
    expect(out).toContain("<internal-host>")
  })

  test("query-string with `+` and `#` does not leak past internal-host marker", () => {
    // Char class previously omitted +/#/,/; — secrets after `?` survived.
    const out = Telemetry.maskString("Failed http://10.0.0.1/x?token=foo+bar#frag")
    expect(out).not.toContain("foo+bar")
    expect(out).not.toContain("#frag")
    expect(out).toContain("<internal-host>")
  })

  test("internal URL with basic-auth userinfo is fully redacted (cubic P1 regression)", () => {
    // Pre-fix: regex started with the host alternation, missing `user:pass@`
    // prefix, so `https://admin:hunter2@10.0.0.5/x` did NOT match — basic-auth
    // creds + internal host both leaked. Now matches via the optional
    // `(?:[^\/\s@]+@)?` group.
    const out = Telemetry.maskString("Cannot reach https://admin:hunter2@10.0.0.5/secret")
    expect(out).not.toContain("hunter2")
    expect(out).not.toContain("admin:")
    expect(out).not.toContain("10.0.0.5")
    expect(out).toContain("<internal-host>")
  })

  test("0.0.0.0 (any-interface bind) is masked", () => {
    const out = Telemetry.maskString("Probe failed http://0.0.0.0:8080/")
    expect(out).not.toContain("0.0.0.0")
    expect(out).toContain("<internal-host>")
  })
})
