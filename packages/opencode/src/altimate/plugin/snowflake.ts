import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Auth, OAUTH_DUMMY_KEY } from "@/auth"

/**
 * Build the set of Snowflake Cortex model IDs that support tool calling.
 * Derived from `provider.models[*].capabilities.toolcall` so the picker's
 * advertised capability and the request-transform's behavior cannot drift —
 * adding a tool-capable model to the provider definition (or registering one
 * via `altimate-code.json`) is the single source of truth.
 *
 * Indexes both the picker key and the model's `api.id` (and `id`) so that
 * aliased models — where a user registers e.g. `"my-alias": { "id":
 * "claude-opus-4-7" }` in their config — match correctly. The transform
 * compares against `parsed.model` which is the API id sent in the request
 * body, not the picker map key.
 *
 * Snowflake's documented constraint: only Claude and OpenAI models accept
 * tools on Cortex; everything else rejects with "tool calling is not supported."
 */
export function buildToolCapableSet(
  models: Record<
    string,
    {
      id?: string
      api?: { id?: string }
      capabilities: { toolcall: boolean }
    }
  >,
): ReadonlySet<string> {
  const set = new Set<string>()
  for (const [key, m] of Object.entries(models)) {
    if (!m.capabilities.toolcall) continue
    set.add(key)
    if (m.id) set.add(m.id)
    if (m.api?.id) set.add(m.api.id)
  }
  return set
}

/** Snowflake account identifiers contain only alphanumeric, hyphen, underscore, and dot characters. */
export const VALID_ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/

/** Snowflake Cortex accepts at most 4 cache breakpoints per request (Anthropic limit). */
const CACHE_BREAKPOINT_LIMIT = 4

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Roles whose content-block cache markers Cortex honors (verified live 2026-07-20). */
const CACHEABLE_ROLES = new Set(["system", "user", "assistant"])

/**
 * Attach a cache marker to the last non-empty content block of a message.
 * String content is wrapped into a text block. Returns false when the message
 * has no block that can carry a marker (e.g. empty content).
 */
function attachMarker(msg: Record<string, any>, marker: Record<string, any>): boolean {
  if (typeof msg.content === "string") {
    if (msg.content.length === 0) return false
    msg.content = [{ type: "text", text: msg.content, cache_control: marker }]
    return true
  }
  if (!Array.isArray(msg.content)) return false
  for (let i = msg.content.length - 1; i >= 0; i--) {
    const block = msg.content[i]
    if (!isRecord(block)) continue
    if (block.type === "text" && (typeof block.text !== "string" || block.text.length === 0)) continue
    if (!isRecord(block.cache_control)) block.cache_control = marker
    return true
  }
  return false
}

/**
 * Relocate prompt-cache markers into content blocks for Claude models.
 *
 * Cortex only honors caching via `messages[].content[].cache_control`
 * (ephemeral, max 4 breakpoints) — and only on system/user/assistant messages;
 * markers on `role:"tool"` messages are accepted but silently ignored
 * (verified against a live Cortex account). The OpenAI-compatible AI SDK
 * serializes our cache providerOptions as message-level fields — on system
 * messages, on single-text-part user messages (collapsed to string content),
 * on tool messages, and into assistant `tool_calls` entries — all of which
 * Cortex ignores, so every request bills the full input rate.
 *
 * Message-level markers move into that message's content blocks; a marker on
 * a tool message (or a message with no attachable block) walks back to the
 * nearest earlier cacheable message, keeping the breakpoint as close to the
 * end of the conversation as Cortex allows.
 *
 * Returns true when the request carries block-level markers after relocation.
 */
export function relocateCacheControl(parsed: Record<string, any>): boolean {
  if (typeof parsed.model !== "string" || !parsed.model.includes("claude")) return false
  if (!Array.isArray(parsed.messages)) return false
  const messages = parsed.messages

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx]
    if (!isRecord(msg)) continue

    // The SDK spreads part metadata into tool_calls entries — invalid location.
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (isRecord(call)) delete call.cache_control
      }
    }

    const marker = isRecord(msg.cache_control) ? msg.cache_control : undefined
    delete msg.cache_control
    if (!marker) continue

    for (let t = idx; t >= 0; t--) {
      const target = messages[t]
      if (!isRecord(target) || !CACHEABLE_ROLES.has(target.role)) continue
      if (attachMarker(target, marker)) break
    }
  }

  // Enforce the breakpoint limit, keeping the last markers (longest prefixes).
  // Markers on non-cacheable roles are dead weight against the limit — drop them.
  const marked: Record<string, any>[] = []
  for (const msg of messages) {
    if (!isRecord(msg) || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (!isRecord(block) || !block.cache_control) continue
      if (!CACHEABLE_ROLES.has(msg.role)) {
        delete block.cache_control
        continue
      }
      marked.push(block)
    }
  }
  for (const block of marked.slice(0, Math.max(0, marked.length - CACHE_BREAKPOINT_LIMIT))) {
    delete block.cache_control
  }

  return marked.length > 0
}

function stripParsedCacheControl(parsed: Record<string, any>) {
  if (!Array.isArray(parsed.messages)) return
  for (const msg of parsed.messages) {
    if (!isRecord(msg)) continue
    delete msg.cache_control
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (isRecord(call)) delete call.cache_control
      }
    }
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (isRecord(block)) delete block.cache_control
    }
  }
}

/** Remove every cache marker from a request body (fallback when Cortex rejects them). */
export function stripCacheControl(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText)
    stripParsedCacheControl(parsed)
    return JSON.stringify(parsed)
  } catch {
    return bodyText
  }
}

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
 *
 * @param toolCapable Model IDs that should retain `tools` / `tool_choice` / tool messages.
 *                    Build via `buildToolCapableSet(provider.models)` at loader time so
 *                    user-added models with `tool_call: true` in `altimate-code.json` are honored.
 * @param cacheControl When false, strip every cache marker instead of relocating
 *                     them into content blocks (set after Cortex rejected a
 *                     cache-marked request).
 */
export function transformSnowflakeBody(
  bodyText: string,
  toolCapable: ReadonlySet<string>,
  cacheControl = true,
): { body: string; syntheticStop?: Response; cacheApplied?: boolean } {
  const parsed = JSON.parse(bodyText)

  // Snowflake uses max_completion_tokens instead of max_tokens
  if ("max_tokens" in parsed) {
    parsed.max_completion_tokens = parsed.max_tokens
    delete parsed.max_tokens
  }

  let cacheApplied = false
  if (cacheControl) cacheApplied = relocateCacheControl(parsed)
  else stripParsedCacheControl(parsed)

  // Strip tools for models that don't support tool calling on Snowflake Cortex.
  // Also remove orphaned tool_calls from messages to avoid Snowflake API errors.
  if (!toolCapable.has(parsed.model)) {
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
        cacheApplied,
        syntheticStop: new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        }),
      }
    }
  }

  return { body: JSON.stringify(parsed), cacheApplied }
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

        // Build the tool-capable allowlist from the live provider definition.
        // This includes both hardcoded entries in provider.ts AND any models the
        // user registered via `altimate-code.json` with `"tool_call": true`.
        // Without this, the documented escape hatch is silently broken — picker
        // shows the model as tool-capable, but the transform strips tools at
        // request time because a static hardcoded set never sees user additions.
        const toolCapable = buildToolCapableSet(provider.models)

        // Cortex documents block-level cache_control for Claude models, but not
        // for every message role. If an account rejects a cache-marked request,
        // fall back once and stop injecting markers for the rest of the session.
        let cacheControlSupported = true

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
            let cacheApplied = false
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
                  const result = transformSnowflakeBody(text, toolCapable, cacheControlSupported)
                  if (result.syntheticStop) return result.syntheticStop
                  body = result.body
                  cacheApplied = result.cacheApplied === true
                  headers.delete("content-length")
                }
              } catch {
                // JSON parse error — pass original body through untransformed
              }
            }

            const response = await fetch(requestInput, { ...init, headers, body })

            // If Cortex rejects a cache-marked request, retry once without the
            // markers; when the stripped retry succeeds, the markers were the
            // problem — disable caching for the rest of the session.
            if (response.status === 400 && cacheApplied && typeof body === "string") {
              const stripped = stripCacheControl(body)
              if (stripped !== body) {
                const retry = await fetch(requestInput, { ...init, headers, body: stripped })
                if (retry.ok) {
                  cacheControlSupported = false
                  void response.body?.cancel().catch(() => {})
                  return retry
                }
                void retry.body?.cancel().catch(() => {})
                return response
              }
            }

            return response
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
