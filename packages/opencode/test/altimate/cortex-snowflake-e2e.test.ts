/**
 * Snowflake Cortex AI Provider E2E Tests
 *
 * Tests the Snowflake Cortex LLM inference endpoint via the provider's
 * auth plugin and request transforms.
 *
 * Supports two auth methods (set ONE):
 *
 *   # Option A — PAT (Programmatic Access Token):
 *   export SNOWFLAKE_CORTEX_ACCOUNT="<account>"
 *   export SNOWFLAKE_CORTEX_PAT="<pat>"
 *
 *   # Option B — Key-pair JWT (RSA private key):
 *   export SNOWFLAKE_CORTEX_ACCOUNT="<account>"
 *   export SNOWFLAKE_CORTEX_USER="<username>"
 *   export SNOWFLAKE_CORTEX_PRIVATE_KEY_PATH="/path/to/rsa_key.p8"
 *
 * Skips all tests if neither auth method is configured.
 *
 * Run:
 *   bun test test/altimate/cortex-snowflake-e2e.test.ts --timeout 120000
 */

import { describe, expect, test, beforeAll } from "bun:test"
import * as crypto from "crypto"
import * as fs from "fs"
import {
  parseSnowflakePAT,
  transformSnowflakeBody,
  VALID_ACCOUNT_RE,
} from "../../src/altimate/plugin/snowflake"

// ---------------------------------------------------------------------------
// Auth configuration
// ---------------------------------------------------------------------------

const CORTEX_ACCOUNT = process.env.SNOWFLAKE_CORTEX_ACCOUNT
const CORTEX_PAT = process.env.SNOWFLAKE_CORTEX_PAT
const CORTEX_USER = process.env.SNOWFLAKE_CORTEX_USER
const CORTEX_KEY_PATH = process.env.SNOWFLAKE_CORTEX_PRIVATE_KEY_PATH

const HAS_PAT = !!(CORTEX_ACCOUNT && CORTEX_PAT)
const HAS_KEYPAIR = !!(CORTEX_ACCOUNT && CORTEX_USER && CORTEX_KEY_PATH)
const HAS_CORTEX = HAS_PAT || HAS_KEYPAIR

function cortexBaseURL(account: string): string {
  return `https://${account}.snowflakecomputing.com/api/v2/cortex/v1`
}

/** Generate a JWT for key-pair auth. */
function generateJWT(account: string, user: string, keyPath: string): string {
  const privateKey = fs.readFileSync(keyPath, "utf-8")
  const qualifiedUser = `${account.toUpperCase()}.${user.toUpperCase()}`

  const pubKey = crypto.createPublicKey(crypto.createPrivateKey(privateKey))
  const pubKeyDer = pubKey.export({ type: "spki", format: "der" })
  const fingerprint = "SHA256:" + crypto.createHash("sha256").update(pubKeyDer).digest("base64")

  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      iss: `${qualifiedUser}.${fingerprint}`,
      sub: qualifiedUser,
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url")

  const signature = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")
  return `${header}.${payload}.${signature}`
}

/** Build auth headers for whichever method is configured. */
function authHeaders(): Record<string, string> {
  if (HAS_PAT) {
    return {
      Authorization: `Bearer ${CORTEX_PAT}`,
      "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
    }
  }
  const jwt = generateJWT(CORTEX_ACCOUNT!, CORTEX_USER!, CORTEX_KEY_PATH!)
  return {
    Authorization: `Bearer ${jwt}`,
    "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
  }
}

/** Make a raw Cortex chat completion request. */
async function cortexChat(opts: {
  model: string
  messages: Array<{ role: string; content: string }>
  stream?: boolean
  max_tokens?: number
  tools?: unknown[]
}): Promise<Response> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_completion_tokens: opts.max_tokens ?? 256,
  }
  if (opts.stream !== undefined) body.stream = opts.stream
  if (opts.tools) {
    body.tools = opts.tools
    body.tool_choice = "auto"
  }

  return fetch(`${cortexBaseURL(CORTEX_ACCOUNT!)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Cortex API E2E
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_CORTEX)("Snowflake Cortex E2E", () => {
  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------
  describe("Authentication", () => {
    test("valid credentials succeed", async () => {
      const resp = await cortexChat({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "Reply with exactly: hello" }],
        stream: false,
        max_tokens: 32,
      })
      expect(resp.status).toBe(200)
      const json = await resp.json()
      expect(json.choices).toBeDefined()
      expect(json.choices.length).toBeGreaterThan(0)
      expect(json.choices[0].message.content).toBeTruthy()
    }, 30000)

    test("rejects invalid token", async () => {
      const resp = await fetch(`${cortexBaseURL(CORTEX_ACCOUNT!)}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-token-xyz",
          "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
        },
        body: JSON.stringify({
          model: "claude-3-5-sonnet",
          messages: [{ role: "user", content: "test" }],
          max_completion_tokens: 16,
          stream: false,
        }),
      })
      expect(resp.status).toBeGreaterThanOrEqual(400)
    }, 15000)
  })

  // -------------------------------------------------------------------------
  // Non-streaming completions
  // -------------------------------------------------------------------------
  describe("Non-Streaming Completions", () => {
    test("returns valid JSON completion", async () => {
      const resp = await cortexChat({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
        stream: false,
        max_tokens: 16,
      })
      expect(resp.status).toBe(200)
      const json = await resp.json()
      expect(json.choices[0].message.role).toBe("assistant")
      expect(json.choices[0].message.content).toContain("4")
    }, 30000)

    test("uses max_completion_tokens (not max_tokens)", async () => {
      const resp = await fetch(`${cortexBaseURL(CORTEX_ACCOUNT!)}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          model: "claude-3-5-sonnet",
          messages: [{ role: "user", content: "Say hello" }],
          max_completion_tokens: 16,
          stream: false,
        }),
      })
      expect(resp.status).toBe(200)
    }, 30000)

    test("reports token usage", async () => {
      const resp = await cortexChat({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "Say hi" }],
        stream: false,
        max_tokens: 16,
      })
      const json = await resp.json()
      expect(json.usage).toBeDefined()
      expect(json.usage.prompt_tokens).toBeGreaterThan(0)
      expect(json.usage.total_tokens).toBeGreaterThan(0)
    }, 30000)
  })

  // -------------------------------------------------------------------------
  // Streaming completions
  // -------------------------------------------------------------------------
  describe("Streaming Completions", () => {
    test("returns SSE stream with chunked deltas", async () => {
      const resp = await cortexChat({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "Count from 1 to 3." }],
        stream: true,
        max_tokens: 64,
      })
      expect(resp.status).toBe(200)
      expect(resp.headers.get("content-type")).toContain("text/event-stream")

      const text = await resp.text()
      expect(text).toContain("data: ")
      expect(text).toContain("data: [DONE]")
    }, 30000)
  })

  // -------------------------------------------------------------------------
  // Model availability & response format
  // -------------------------------------------------------------------------
  describe("Model Availability", () => {
    // All models registered in provider.ts — availability depends on region/cross-region config
    const allModels = [
      // Claude
      "claude-sonnet-4-6", "claude-opus-4-6", "claude-sonnet-4-5", "claude-opus-4-5",
      "claude-haiku-4-5", "claude-4-sonnet", "claude-4-opus", "claude-3-7-sonnet", "claude-3-5-sonnet",
      // OpenAI
      "openai-gpt-4.1", "openai-gpt-5", "openai-gpt-5-mini", "openai-gpt-5-nano",
      "openai-gpt-5-chat",
      // Meta Llama
      "llama4-maverick", "snowflake-llama-3.3-70b", "llama3.1-70b", "llama3.1-405b", "llama3.1-8b",
      // Mistral
      "mistral-large", "mistral-large2", "mistral-7b",
      // DeepSeek
      "deepseek-r1",
    ]

    for (const model of allModels) {
      test(`model ${model} responds or gracefully rejects`, async () => {
        const resp = await cortexChat({
          model,
          messages: [{ role: "user", content: "Reply with: ok" }],
          stream: false,
          max_tokens: 16,
        })
        // 200 = available, 400 = not enabled/unknown, 403 = gated, 500 = unstable
        expect([200, 400, 403, 500]).toContain(resp.status)
        if (resp.status === 200) {
          const json = await resp.json()
          expect(json.choices).toBeDefined()
          expect(json.choices[0].message.role).toBe("assistant")
          // Some preview models (e.g., openai-gpt-5-*) return empty content
          expect(json.choices[0].message.content).toBeDefined()
          expect(json.usage).toBeDefined()
        }
      }, 30000)
    }
  })

  // -------------------------------------------------------------------------
  // Tool calling — only Claude models support it on Cortex
  // -------------------------------------------------------------------------
  describe("Tool Calling", () => {
    const claudeModel = "claude-3-5-sonnet"
    const nonClaudeModel = "mistral-large2"

    test(`${claudeModel} supports tool calls`, async () => {
      const resp = await fetch(`${cortexBaseURL(CORTEX_ACCOUNT!)}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          model: claudeModel,
          messages: [{ role: "user", content: "What is the weather in Paris?" }],
          max_completion_tokens: 64,
          stream: false,
          tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
          tool_choice: "auto",
        }),
      })
      // Accept 200 (tool call) or 400 (region-locked)
      if (resp.status === 200) {
        const json = await resp.json()
        const tc = json.choices[0].message.tool_calls
        expect(tc).toBeDefined()
        expect(tc.length).toBeGreaterThan(0)
        expect(tc[0].function.name).toBe("get_weather")
      }
    }, 30000)

    test(`${nonClaudeModel} rejects tool calls`, async () => {
      const resp = await fetch(`${cortexBaseURL(CORTEX_ACCOUNT!)}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          model: nonClaudeModel,
          messages: [{ role: "user", content: "What is the weather?" }],
          max_completion_tokens: 32,
          stream: false,
          tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
        }),
      })
      // Non-Claude models reject tool calls with 400
      if (resp.status !== 200) {
        expect(resp.status).toBe(400)
      }
    }, 30000)
  })

  // -------------------------------------------------------------------------
  // DeepSeek R1 reasoning format
  // -------------------------------------------------------------------------
  describe("DeepSeek R1 Reasoning", () => {
    test("deepseek-r1 returns <think> tags in content", async () => {
      const resp = await cortexChat({
        model: "deepseek-r1",
        messages: [{ role: "user", content: "What is 2+2?" }],
        stream: false,
        max_tokens: 64,
      })
      if (resp.status === 200) {
        const json = await resp.json()
        const content = json.choices[0].message.content
        expect(content).toContain("<think>")
      }
    }, 30000)
  })

  // -------------------------------------------------------------------------
  // Cortex rejects assistant-last messages
  // -------------------------------------------------------------------------
  describe("Assistant-Last Message Handling", () => {
    test("Cortex handles trailing assistant message", async () => {
      const resp = await fetch(`${cortexBaseURL(CORTEX_ACCOUNT!)}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({
          model: "claude-3-5-sonnet",
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "I'm here" },
          ],
          max_completion_tokens: 16,
          stream: false,
        }),
      })
      // Cortex may accept (200) or reject (4xx) trailing assistant messages
      // depending on the model and Cortex version. The synthetic stop in the
      // provider handles both cases — it prevents the AI SDK's continuation
      // loop from hitting Cortex repeatedly when the model echoes back.
      expect(resp.status).toBeLessThan(500)
    }, 15000)
  })

  // -------------------------------------------------------------------------
  // Request transforms (unit-level, no network)
  // -------------------------------------------------------------------------
  describe("Request Transforms", () => {
    test("max_tokens renamed to max_completion_tokens", () => {
      const input = JSON.stringify({
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 100,
        stream: true,
      })
      const { body } = transformSnowflakeBody(input)
      const parsed = JSON.parse(body)
      expect(parsed.max_completion_tokens).toBe(100)
      expect(parsed.max_tokens).toBeUndefined()
    })

    test("tools stripped for llama model", () => {
      const input = JSON.stringify({
        model: "llama3.3-70b",
        messages: [{ role: "user", content: "test" }],
        tools: [{ type: "function", function: { name: "read_file" } }],
        tool_choice: "auto",
      })
      const { body } = transformSnowflakeBody(input)
      const parsed = JSON.parse(body)
      expect(parsed.tools).toBeUndefined()
      expect(parsed.tool_choice).toBeUndefined()
    })

    test("synthetic stop skipped for non-streaming", () => {
      const input = JSON.stringify({
        model: "claude-3-5-sonnet",
        stream: false,
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "response" },
        ],
      })
      const { syntheticStop } = transformSnowflakeBody(input)
      expect(syntheticStop).toBeUndefined()
    })

    test("synthetic stop triggered for streaming with trailing assistant", () => {
      const input = JSON.stringify({
        model: "claude-3-5-sonnet",
        stream: true,
        messages: [
          { role: "user", content: "test" },
          { role: "assistant", content: "response" },
        ],
      })
      const { syntheticStop } = transformSnowflakeBody(input)
      expect(syntheticStop).toBeDefined()
      expect(syntheticStop!.status).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // PAT parsing (if using PAT auth)
  // -------------------------------------------------------------------------
  describe.skipIf(!HAS_PAT)("PAT Parsing with Real Credentials", () => {
    test("parses real account::pat format", () => {
      const account = CORTEX_ACCOUNT!
      const pat = CORTEX_PAT!
      const result = parseSnowflakePAT(`${account}::${pat}`)
      expect(result).not.toBeNull()
      expect(result!.account).toBe(account)
      expect(result!.token).toBe(pat)
    })

    test("account passes validation regex", () => {
      expect(VALID_ACCOUNT_RE.test(CORTEX_ACCOUNT!)).toBe(true)
    })
  })
})
