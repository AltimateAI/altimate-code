import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Auth, OAUTH_DUMMY_KEY } from "@/auth"

// Only OpenAI and Claude models support tool calling on Snowflake Cortex.
// All other models reject tools with "tool calling is not supported".
const TOOLCALL_MODELS = new Set([
  // Claude
  "claude-sonnet-4-6", "claude-opus-4-6", "claude-sonnet-4-5", "claude-opus-4-5",
  "claude-haiku-4-5", "claude-4-sonnet", "claude-4-opus", "claude-3-7-sonnet", "claude-3-5-sonnet",
  // OpenAI
  "openai-gpt-4.1", "openai-gpt-5", "openai-gpt-5-mini", "openai-gpt-5-nano",
  "openai-gpt-5-chat", "openai-gpt-oss-120b", "openai-o4-mini",
])

/** Snowflake account identifiers contain only alphanumeric, hyphen, underscore, and dot characters. */
export const VALID_ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/

/** Parse a `account::token` PAT credential string. */
export function parseSnowflakePAT(code: string): { account: string; token: string } | null {
  const sep = code.indexOf("::")
  if (sep === -1) return null
  const account = code.substring(0, sep).trim()
  const token = code.substring(sep + 2).trim()
  if (!account || !token) return null
  if (!VALID_ACCOUNT_RE.test(account)) return null
  return { account, token }
}

/**
 * Transform a Snowflake Cortex request body string.
 * Returns a Response to short-circuit the fetch (synthetic stop), or undefined to continue normally.
 */
export function transformSnowflakeBody(bodyText: string): { body: string; syntheticStop?: Response } {
  const parsed = JSON.parse(bodyText)

  // Snowflake uses max_completion_tokens instead of max_tokens
  if ("max_tokens" in parsed) {
    parsed.max_completion_tokens = parsed.max_tokens
    delete parsed.max_tokens
  }

  // Strip tools for models that don't support tool calling on Snowflake Cortex.
  // Also remove orphaned tool_calls from messages to avoid Snowflake API errors.
  if (!TOOLCALL_MODELS.has(parsed.model)) {
    delete parsed.tools
    delete parsed.tool_choice
    if (Array.isArray(parsed.messages)) {
      for (const msg of parsed.messages) {
        if (msg.tool_calls) delete msg.tool_calls
      }
      parsed.messages = parsed.messages.filter((msg: { role: string }) => msg.role !== "tool")
    }
  }

  // Snowflake rejects requests where the last message is an assistant role.
  // The AI SDK makes "continuation check" requests with the model's last response
  // at the end. Stripping causes an infinite loop (same request → same response).
  // Instead, short-circuit by returning a synthetic "stop" streaming response.
  if (Array.isArray(parsed.messages)) {
    const last = parsed.messages.at(-1)
    if (parsed.stream !== false && last?.role === "assistant" && (!Array.isArray(last.tool_calls) || last.tool_calls.length === 0)) {
      const encoder = new TextEncoder()
      const chunks = [
        `data: {"id":"sf-done","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}\n\n`,
        `data: {"id":"sf-done","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n`,
        `data: [DONE]\n\n`,
      ]
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      })
      return {
        body: JSON.stringify(parsed),
        syntheticStop: new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        }),
      }
    }
  }

  return { body: JSON.stringify(parsed) }
}

export async function SnowflakeCortexAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "snowflake-cortex",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Zero costs (billed via Snowflake credits)
        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }

            headers.set("authorization", `Bearer ${currentAuth.access}`)
            headers.set("X-Snowflake-Authorization-Token-Type", "PROGRAMMATIC_ACCESS_TOKEN")

            let body = init?.body
            if (body) {
              try {
                let text: string
                if (typeof body === "string") {
                  text = body
                } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
                  text = new TextDecoder().decode(body)
                } else {
                  // ReadableStream, Blob, FormData — pass through untransformed
                  text = ""
                }
                if (text) {
                  const result = transformSnowflakeBody(text)
                  if (result.syntheticStop) return result.syntheticStop
                  body = result.body
                  headers.delete("content-length")
                }
              } catch {
                // JSON parse error — pass original body through untransformed
              }
            }

            return fetch(requestInput, { ...init, headers, body })
          },
        }
      },
      methods: [
        {
          label: "Snowflake PAT",
          type: "oauth",
          authorize: async () => ({
            url: "https://app.snowflake.com",
            instructions:
              "Enter your credentials as: <account-identifier>::<PAT-token>\n  e.g. myorg-myaccount::pat-token-here\n  Create a PAT in Snowsight: Admin → Security → Programmatic Access Tokens",
            method: "code" as const,
            callback: async (code: string) => {
              const parsed = parseSnowflakePAT(code)
              if (!parsed) return { type: "failed" as const }
              return {
                type: "success" as const,
                access: parsed.token,
                refresh: "",
                // PATs have variable TTLs (default 90 days); use conservative expiry
                expires: Date.now() + 90 * 24 * 60 * 60 * 1000,
                accountId: parsed.account,
              }
            },
          }),
        },
      ],
    },
  }
}
