import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderID } from "./schema"

export namespace ProviderError {
  // Adapted from overflow detection patterns in:
  // https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/overflow.ts
  const OVERFLOW_PATTERNS = [
    /prompt is too long/i, // Anthropic
    /input is too long for requested model/i, // Amazon Bedrock
    /exceeds the context window/i, // OpenAI (Completions + Responses API message text)
    /input token count.*exceeds the maximum/i, // Google (Gemini)
    /maximum prompt length is \d+/i, // xAI (Grok)
    /reduce the length of the messages/i, // Groq
    /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek
    /exceeds the limit of \d+/i, // GitHub Copilot
    /exceeds the available context size/i, // llama.cpp server
    /greater than the context length/i, // LM Studio
    /context window exceeds limit/i, // MiniMax
    /exceeded model token limit/i, // Kimi For Coding, Moonshot
    /context[_ ]length[_ ]exceeded/i, // Generic fallback
    /request entity too large/i, // HTTP 413
    /the request was too long/i, // Azure OpenAI
    /maximum tokens for requested operation/i, // Azure OpenAI
  ]

  function isOpenAiErrorRetryable(e: APICallError) {
    const status = e.statusCode
    if (!status) return e.isRetryable
    // altimate_change start — upstream_fix: don't retry-storm on model_not_found.
    // OpenAI 404s are forced retryable below because some legitimate models 404
    // transiently, but `model_not_found` will never recover; retrying 5x just
    // delays the user seeing the (now-readable) error message.
    if (status === 404) {
      try {
        const body = e.responseBody ? JSON.parse(e.responseBody) : null
        if (body?.error?.code === "model_not_found") return false
      } catch {
        // Malformed JSON on a 404 falls through to "force retryable" below —
        // intentional; some providers emit non-JSON 404 bodies for transient
        // model availability blips and those should still retry.
      }
    }
    // altimate_change end
    // openai sometimes returns 404 for models that are actually available
    return status === 404 || e.isRetryable
  }

  // Providers not reliably handled in this function:
  // - z.ai: can accept overflow silently (needs token-count/context-window checks)
  function isOverflow(message: string) {
    if (OVERFLOW_PATTERNS.some((p) => p.test(message))) return true

    // Providers/status patterns handled outside of regex list:
    // - Cerebras: often returns "400 (no body)" / "413 (no body)"
    // - Mistral: often returns "400 (no body)" / "413 (no body)"
    return /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)
  }

  function message(providerID: ProviderID, e: APICallError) {
    return iife(() => {
      const msg = e.message
      if (msg === "") {
        if (e.responseBody) return e.responseBody
        if (e.statusCode) {
          const err = STATUS_CODES[e.statusCode]
          if (err) return err
        }
        return "Unknown error"
      }

      if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
        return msg
      }

      try {
        const body = JSON.parse(e.responseBody)
        // altimate_change start — upstream_fix: extract provider error messages
        // across the four shapes in the wild:
        //   1. {error: {message: "..."}}  — OpenAI / Azure OpenAI / OpenRouter
        //   2. {message: "..."}           — Anthropic-style top-level
        //   3. {errorMessage: "..."}      — Bedrock / AWS Lambda
        //   4. {error: "..."}             — legacy plain-string shape
        // The original `body.message || body.error || body.error?.message` short-
        // circuited on a truthy parent object, failed the `typeof === "string"`
        // guard, and dumped the raw body. Use an explicit-typeof ternary so a
        // truthy non-string at any tier can't block a valid string further down
        // the chain (matches parseStreamError's pattern below).
        const errMsg =
          typeof body.error?.message === "string"
            ? body.error.message
            : typeof body.message === "string"
              ? body.message
              : typeof body.errorMessage === "string"
                ? body.errorMessage
                : typeof body.error === "string"
                  ? body.error
                  : undefined
        if (errMsg) return `${msg}: ${errMsg}`
        // altimate_change end
      } catch {}

      // If responseBody is HTML (e.g. from a gateway or proxy error page),
      // provide a human-readable message instead of dumping raw markup
      if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
        if (e.statusCode === 401) {
          // altimate_change start — branding: altimate auth
          return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `altimate auth login <your provider URL>` to re-authenticate."
          // altimate_change end
        }
        if (e.statusCode === 403) {
          return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
        }
        return msg
      }

      return `${msg}: ${e.responseBody}`
    }).trim()
  }

  function json(input: unknown) {
    if (typeof input === "string") {
      try {
        const result = JSON.parse(input)
        if (result && typeof result === "object") return result
        return undefined
      } catch {
        return undefined
      }
    }
    if (typeof input === "object" && input !== null) {
      return input
    }
    return undefined
  }

  export type ParsedStreamError =
    | {
        type: "context_overflow"
        message: string
        responseBody: string
      }
    | {
        type: "api_error"
        message: string
        isRetryable: false
        responseBody: string
      }

  export function parseStreamError(input: unknown): ParsedStreamError | undefined {
    const body = json(input)
    if (!body) return

    const responseBody = JSON.stringify(body)
    if (body.type !== "error") return

    switch (body?.error?.code) {
      case "context_length_exceeded":
        return {
          type: "context_overflow",
          message: "Input exceeds context window of this model",
          responseBody,
        }
      case "insufficient_quota":
        return {
          type: "api_error",
          message: "Quota exceeded. Check your plan and billing details.",
          isRetryable: false,
          responseBody,
        }
      case "usage_not_included":
        return {
          type: "api_error",
          message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
          isRetryable: false,
          responseBody,
        }
      case "invalid_prompt":
        return {
          type: "api_error",
          message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
          isRetryable: false,
          responseBody,
        }
    }

    // altimate_change start — upstream_fix: extend extraction to non-OpenAI error
    // codes. The switch above only handles 4 OpenAI shapes; everything else fell
    // through to `JSON.stringify(e)` in the caller (session/message-v2.ts), which
    // showed users `Unknown: {"type":"error",...}`. Apply the same string-typeof
    // chain we use in parseAPICallError so any extractable provider message lands
    // as a clean api_error.
    const fallbackMsg =
      typeof body?.error?.message === "string"
        ? body.error.message
        : typeof body?.message === "string"
          ? body.message
          : typeof body?.errorMessage === "string"
            ? body.errorMessage
            : typeof body?.error === "string"
              ? body.error
              : undefined
    if (fallbackMsg) {
      return {
        type: "api_error",
        message: fallbackMsg,
        isRetryable: false,
        responseBody,
      }
    }
    // altimate_change end
  }

  export type ParsedAPICallError =
    | {
        type: "context_overflow"
        message: string
        responseBody?: string
      }
    | {
        type: "api_error"
        message: string
        statusCode?: number
        isRetryable: boolean
        responseHeaders?: Record<string, string>
        responseBody?: string
        metadata?: Record<string, string>
      }

  // altimate_change start — cap responseBody at 4KB before it lands on a
  // MessageV2.APIError. Without this cap, a hostile gateway returning a 100KB
  // body (or just verbose providers like LiteLLM) would inflate local storage,
  // share-backend uploads, and diagnostic dumps.
  const RESPONSE_BODY_CAP = 4096
  function capResponseBody(body: string | undefined): string | undefined {
    if (!body) return body
    if (body.length <= RESPONSE_BODY_CAP) return body
    return body.slice(0, RESPONSE_BODY_CAP) + `…[truncated ${body.length - RESPONSE_BODY_CAP} chars]`
  }
  // altimate_change end

  // altimate_change start — sanitize metadata.url before it lands on the
  // parsed error. Two transforms are applied:
  //   (1) basic-auth userinfo (`user:pass@…`) is stripped on every URL,
  //       internal or public — a credential in a misconfigured proxy URL
  //       must not flow into telemetry / local storage / share regardless
  //       of where the URL points.
  //   (2) the hostname is rewritten to `internal-host.redacted` if it
  //       matches an internal endpoint (RFC1918, *.local, *.internal,
  //       localhost, *.localhost, IPv6 loopback / ULA / link-local, or
  //       the AWS IMDS address 169.254.169.254). Public provider URLs
  //       are otherwise preserved for debugging.
  function maskInternalHost(url: string): string {
    try {
      const u = new URL(url)
      // u.hostname keeps IPv6 brackets (e.g. "[::1]"); strip for regex match.
      const host = u.hostname.replace(/^\[|\]$/g, "")
      const hadCredentials = u.username !== "" || u.password !== ""
      // Always clear userinfo — the credential is the riskier part of the URL.
      u.username = ""
      u.password = ""
      const isInternal =
        host === "localhost" ||
        host === "0.0.0.0" || // any-interface bind, often misconfigured proxy
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.endsWith(".localhost") ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^169\.254\./.test(host) || // AWS IMDS / link-local IPv4
        host === "::1" || // IPv6 loopback
        /^fc[0-9a-f]{2}:/i.test(host) || // IPv6 ULA (RFC4193 fc00::/8)
        /^fd[0-9a-f]{2}:/i.test(host) || // IPv6 ULA (RFC4193 fd00::/8)
        /^fe80:/i.test(host) // IPv6 link-local
      if (isInternal) {
        u.hostname = "internal-host.redacted"
        return u.toString()
      }
      // No host change but we may have removed credentials — re-serialize
      // only if userinfo was present, otherwise return the original string
      // so URLs round-trip untouched (preserves trailing slashes, casing).
      return hadCredentials ? u.toString() : url
    } catch {
      return url
    }
  }
  // altimate_change end

  export function parseAPICallError(input: { providerID: ProviderID; error: APICallError }): ParsedAPICallError {
    const m = message(input.providerID, input.error)
    // Check responseBody for context_length_exceeded code (e.g., OpenAI-style errors)
    const bodyParsed = json(input.error.responseBody)
    const codeFromBody = bodyParsed?.error?.code
    if (isOverflow(m) || input.error.statusCode === 413 || codeFromBody === "context_length_exceeded") {
      return {
        type: "context_overflow",
        message: m,
        // altimate_change start — cap responseBody on context_overflow path
        responseBody: capResponseBody(input.error.responseBody),
        // altimate_change end
      }
    }

    // altimate_change start — append a `models` discoverability hint when the
    // error code is model_not_found. Pairs with the retry-storm carve-out in
    // isOpenAiErrorRetryable so the user sees the hint on the first attempt
    // instead of after 5 silent retries.
    let finalMessage = m
    if (codeFromBody === "model_not_found") {
      finalMessage = `${m} Run \`altimate models\` to see available models.`
    }
    // altimate_change end

    // altimate_change start — mask internal hostnames in metadata.url
    const metadata = input.error.url ? { url: maskInternalHost(input.error.url) } : undefined
    // altimate_change end
    return {
      type: "api_error",
      // altimate_change start — finalMessage carries the optional /models hint
      message: finalMessage,
      // altimate_change end
      statusCode: input.error.statusCode,
      isRetryable: input.providerID.startsWith("openai")
        ? isOpenAiErrorRetryable(input.error)
        : input.error.isRetryable,
      responseHeaders: input.error.responseHeaders,
      // altimate_change start — cap responseBody on api_error path
      responseBody: capResponseBody(input.error.responseBody),
      // altimate_change end
      metadata,
    }
  }
}
