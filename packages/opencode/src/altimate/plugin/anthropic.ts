import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { generatePKCE } from "@openauthjs/openauth/pkce"
import { Auth, OAUTH_DUMMY_KEY } from "@/auth"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const TOOL_PREFIX = "mcp_"

async function authorize(mode: "max" | "console"): Promise<{ url: string; verifier: string }> {
  const pkce = await generatePKCE()
  const base = mode === "console" ? "console.anthropic.com" : "claude.ai"
  const url = new URL(`https://${base}/oauth/authorize`)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", "https://console.anthropic.com/oauth/code/callback")
  url.searchParams.set("scope", "org:create_api_key user:profile user:inference")
  url.searchParams.set("code_challenge", pkce.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", pkce.verifier)
  return { url: url.toString(), verifier: pkce.verifier }
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

async function exchange(code: string, verifier: string) {
  const splits = code.split("#")
  const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      code_verifier: verifier,
    }),
  })
  if (!result.ok) return { type: "failed" as const }
  const json: TokenResponse = await result.json()
  return {
    type: "success" as const,
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

export async function AnthropicAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    "experimental.chat.system.transform": async (hookInput, output) => {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude."
      if (hookInput.model?.providerID === "anthropic") {
        output.system.unshift(prefix)
        if (output.system[1]) output.system[1] = prefix + "\n\n" + output.system[1]
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Zero out costs for Pro/Max subscription
        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            // Refresh token if expired or about to expire (30s buffer)
            if (!currentAuth.access || currentAuth.expires < Date.now() + 30_000) {
              let lastError: Error | undefined
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      grant_type: "refresh_token",
                      refresh_token: currentAuth.refresh,
                      client_id: CLIENT_ID,
                    }),
                  })
                  if (!response.ok) {
                    const body = await response.text().catch(() => "")
                    throw new Error(
                      `Anthropic OAuth token refresh failed (HTTP ${response.status}). ` +
                        `Try re-authenticating: altimate-code auth login anthropic` +
                        (body ? ` — ${body.slice(0, 200)}` : ""),
                    )
                  }
                  const json: TokenResponse = await response.json()
                  await input.client.auth.set({
                    path: { id: "anthropic" },
                    body: {
                      type: "oauth",
                      refresh: json.refresh_token,
                      access: json.access_token,
                      expires: Date.now() + json.expires_in * 1000,
                    },
                  })
                  currentAuth.access = json.access_token
                  currentAuth.expires = Date.now() + json.expires_in * 1000
                  lastError = undefined
                  break
                } catch (e) {
                  lastError = e instanceof Error ? e : new Error(String(e))
                  // Don't retry on 4xx (permanent auth failures) — only retry on network errors / 5xx
                  const is4xx = lastError.message.includes("HTTP 4")
                  if (is4xx || attempt >= 2) break
                  await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
                }
              }
              if (lastError) throw lastError
            }

            // Build headers from incoming request
            const requestHeaders = new Headers()
            if (requestInput instanceof Request) {
              requestInput.headers.forEach((value, key) => requestHeaders.set(key, value))
            }
            const requestInit = init ?? {}
            if (requestInit.headers) {
              if (requestInit.headers instanceof Headers) {
                requestInit.headers.forEach((value, key) => requestHeaders.set(key, value))
              } else if (Array.isArray(requestInit.headers)) {
                for (const [key, value] of requestInit.headers) {
                  if (value !== undefined) requestHeaders.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(requestInit.headers)) {
                  if (value !== undefined) requestHeaders.set(key, String(value))
                }
              }
            }

            // Merge required OAuth betas with any existing betas
            const incomingBetas = (requestHeaders.get("anthropic-beta") || "")
              .split(",")
              .map((b) => b.trim())
              .filter(Boolean)
            const mergedBetas = [...new Set(["oauth-2025-04-20", "interleaved-thinking-2025-05-14", ...incomingBetas])].join(",")

            requestHeaders.set("authorization", `Bearer ${currentAuth.access}`)
            requestHeaders.set("anthropic-beta", mergedBetas)
            requestHeaders.set("user-agent", "claude-cli/2.1.2 (external, cli)")
            requestHeaders.delete("x-api-key")

            // Prefix tool names with mcp_ (required by Anthropic's OAuth endpoint)
            let body = requestInit.body
            if (body && typeof body === "string") {
              try {
                const parsed = JSON.parse(body)

                // Sanitize system prompt
                if (parsed.system && Array.isArray(parsed.system)) {
                  parsed.system = parsed.system.map((item: any) => {
                    if (item.type === "text" && item.text) {
                      return {
                        ...item,
                        text: item.text.replace(/OpenCode/g, "Claude Code").replace(/opencode/gi, "Claude"),
                      }
                    }
                    return item
                  })
                }

                if (parsed.tools && Array.isArray(parsed.tools)) {
                  parsed.tools = parsed.tools.map((tool: any) => ({
                    ...tool,
                    name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
                  }))
                }

                if (parsed.messages && Array.isArray(parsed.messages)) {
                  parsed.messages = parsed.messages.map((msg: any) => {
                    if (msg.content && Array.isArray(msg.content)) {
                      msg.content = msg.content.map((block: any) => {
                        if (block.type === "tool_use" && block.name) {
                          return { ...block, name: `${TOOL_PREFIX}${block.name}` }
                        }
                        return block
                      })
                    }
                    return msg
                  })
                }

                body = JSON.stringify(parsed)
              } catch {
                // ignore parse errors
              }
            }

            // Add ?beta=true to /v1/messages requests
            let finalInput = requestInput
            try {
              let requestUrl: URL | null = null
              if (typeof requestInput === "string" || requestInput instanceof URL) {
                requestUrl = new URL(requestInput.toString())
              } else if (requestInput instanceof Request) {
                requestUrl = new URL(requestInput.url)
              }
              if (requestUrl && requestUrl.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
                requestUrl.searchParams.set("beta", "true")
                finalInput = requestInput instanceof Request ? new Request(requestUrl.toString(), requestInput) : requestUrl
              }
            } catch {
              // ignore URL parse errors
            }

            const response = await fetch(finalInput, { ...requestInit, body, headers: requestHeaders })

            // Strip mcp_ prefix from tool names in streaming response
            if (response.body) {
              const reader = response.body.getReader()
              const decoder = new TextDecoder()
              const encoder = new TextEncoder()
              const stream = new ReadableStream({
                async pull(controller) {
                  const { done, value } = await reader.read()
                  if (done) {
                    controller.close()
                    return
                  }
                  let text = decoder.decode(value, { stream: true })
                  text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
                  controller.enqueue(encoder.encode(text))
                },
              })
              return new Response(stream, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              })
            }

            return response
          },
        }
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("max")
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code" as const,
              callback: async (code: string) => exchange(code, verifier),
            }
          },
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console")
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code" as const,
              callback: async (code: string) => {
                const credentials = await exchange(code, verifier)
                if (credentials.type === "failed") return credentials
                const result = await fetch("https://api.anthropic.com/api/oauth/claude_cli/create_api_key", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${credentials.access}`,
                  },
                }).then((r) => r.json())
                return { type: "success" as const, key: result.raw_key }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}
