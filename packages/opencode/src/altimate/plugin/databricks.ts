import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Auth, OAUTH_DUMMY_KEY } from "@/auth"

/**
 * Databricks workspace host regex.
 * Matches patterns like: myworkspace.cloud.databricks.com, adb-1234567890.12.azuredatabricks.net
 */
export const VALID_HOST_RE = /^[a-zA-Z0-9._-]+\.(cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com)$/

/** Parse a `host::token` credential string for Databricks PAT auth. */
export function parseDatabricksPAT(code: string): { host: string; token: string } | null {
  const sep = code.indexOf("::")
  if (sep === -1) return null
  const host = code.substring(0, sep).trim()
  const token = code.substring(sep + 2).trim()
  if (!host || !token) return null
  if (!VALID_HOST_RE.test(host)) return null
  return { host, token }
}

/**
 * Transform a Databricks request body string.
 * Databricks Foundation Model APIs use max_tokens (OpenAI-compatible),
 * but some endpoints may prefer max_completion_tokens.
 */
export function transformDatabricksBody(bodyText: string): { body: string } {
  const parsed = JSON.parse(bodyText)

  // Databricks uses max_tokens for most endpoints, but some newer ones
  // expect max_completion_tokens. Normalize to max_tokens for compatibility.
  if ("max_completion_tokens" in parsed && !("max_tokens" in parsed)) {
    parsed.max_tokens = parsed.max_completion_tokens
    delete parsed.max_completion_tokens
  }

  return { body: JSON.stringify(parsed) }
}

export async function DatabricksAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "databricks",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

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

            let body = init?.body
            if (body) {
              try {
                let text: string
                if (typeof body === "string") {
                  text = body
                } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
                  text = new TextDecoder().decode(body)
                } else {
                  text = ""
                }
                if (text) {
                  const result = transformDatabricksBody(text)
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
          label: "Databricks PAT",
          type: "oauth",
          authorize: async () => ({
            url: "https://accounts.cloud.databricks.com",
            instructions:
              "Enter your credentials as: <workspace-host>::<PAT-token>\n  e.g. myworkspace.cloud.databricks.com::dapi1234567890abcdef\n  Create a PAT in Databricks: Settings → Developer → Access Tokens → Generate New Token",
            method: "code" as const,
            callback: async (code: string) => {
              const parsed = parseDatabricksPAT(code)
              if (!parsed) return { type: "failed" as const }
              return {
                type: "success" as const,
                access: parsed.token,
                refresh: "",
                // Databricks PATs can be configured with custom TTLs; use 90-day default
                expires: Date.now() + 90 * 24 * 60 * 60 * 1000,
                accountId: parsed.host,
              }
            },
          }),
        },
      ],
    },
  }
}
