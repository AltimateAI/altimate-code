import type { NamedError } from "@opencode-ai/core/util/error"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
  // altimate_change start — max retry attempts to prevent infinite retry loops
  export const RETRY_MAX_ATTEMPTS = 5
  // altimate_change end

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs)) {
            return parsedMs
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds)) {
            // convert seconds to milliseconds
            return Math.ceil(parsedSeconds * 1000)
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return Math.ceil(parsed)
          }
        }

        return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
      }
    }

    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    // context overflow errors should not be retried
    if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
    // auth errors (token refresh failures) should be retried — the token may refresh on next attempt
    if (MessageV2.AuthError.isInstance(error)) {
      return `Authentication failed — retrying. If this persists, run: altimate-code auth login ${error.data.providerID}`
    }
    if (MessageV2.APIError.isInstance(error)) {
      // altimate_change start — upstream_fix: retry transient 5xx API errors
      if (!error.data.isRetryable) {
        const status = error.data.statusCode
        if (!(status !== undefined && status >= 500)) return undefined
      }
      // altimate_change end
      if (error.data.responseBody?.includes("FreeUsageLimitError"))
        return `Free usage exceeded, add credits https://altimate.ai/zen`
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    // altimate_change start — core NamedError.toObject() now types `data` as `unknown`;
    // narrow to an optional-message view for the generic (non-typed-error) paths below.
    const data = error.data as { message?: unknown } | undefined
    // altimate_change end

    // altimate_change start — bridge upstream PR #21355: detect plain-text rate-limit
    // messages so providers (Alibaba/DashScope, etc.) that return non-JSON 429s get retried.
    const msg = data?.message
    if (typeof msg === "string") {
      const lower = msg.toLowerCase()
      if (
        lower.includes("rate increased too quickly") ||
        lower.includes("rate limit") ||
        lower.includes("too many requests")
      ) {
        return msg
      }
    }
    // altimate_change end

    const json = iife(() => {
      try {
        if (typeof data?.message === "string") {
          const parsed = JSON.parse(data.message)
          return parsed
        }

        return JSON.parse(data?.message as string)
      } catch {
        return undefined
      }
    })
    try {
      if (!json || typeof json !== "object") return undefined
      const code = typeof json.code === "string" ? json.code : ""

      if (json.type === "error" && json.error?.type === "too_many_requests") {
        return "Too Many Requests"
      }
      if (code.includes("exhausted") || code.includes("unavailable")) {
        return "Provider is overloaded"
      }
      if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
        return "Rate Limited"
      }
      return JSON.stringify(json)
    } catch {
      return undefined
    }
  }
}
