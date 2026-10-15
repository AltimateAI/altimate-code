import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { redactConfig } from "@/cli/cmd/debug/redact"

const config = {
  provider: {
    example: {
      options: {
        apiKey: "sk-example",
        timeout: 1200,
        headers: { Authorization: "Bearer example", "X-API-Key": "key" },
      },
      models: { demo: { variants: { fast: { api_key: "variant-secret" } } } },
    },
  },
  mcp: {
    remote: { oauth: { clientSecret: "oauth-secret", clientId: "public" }, headers: { "x-custom": "opaque" } },
    local: { environment: { SERVICE_TOKEN: "env-secret", PATH: "/usr/bin" } },
  },
  url: "https://user:pass@example.com/path",
  normal: { context_tokens: 200000, name: "example" },
}

describe("debug config redaction", () => {
  cliIt.live("always masks resolved credentials", ({ opencode }) =>
    Effect.gen(function* () {
      const content = JSON.stringify({ provider: config.provider })
      const env = { OPENCODE_CONFIG_CONTENT: content }
      const result = yield* opencode.spawn(["debug", "config"], { env })
      opencode.expectExit(result, 0, "debug config")
      expect(JSON.parse(result.stdout).provider.example.options).toMatchObject({
        apiKey: "***",
        timeout: 1200,
        headers: { Authorization: "***", "X-API-Key": "***" },
      })
      expect(result.stdout).not.toContain("sk-example")
      expect(result.stdout).not.toContain("Bearer example")
    }),
    60_000,
  )

  test("does not mutate the input and preserves unrelated settings", () => {
    const before = structuredClone(config)
    expect(redactConfig(config)).toEqual({
      provider: {
        example: {
          options: { apiKey: "***", timeout: 1200, headers: { Authorization: "***", "X-API-Key": "***" } },
          models: { demo: { variants: { fast: { api_key: "***" } } } },
        },
      },
      mcp: {
        remote: { oauth: { clientSecret: "***", clientId: "public" }, headers: { "x-custom": "***" } },
        local: { environment: { SERVICE_TOKEN: "***", PATH: "/usr/bin" } },
      },
      url: "***",
      normal: config.normal,
    })
    expect(config).toEqual(before)
  })

  test("masks credentials in URL queries and malformed HTTP URLs", () => {
    expect(
      redactConfig({
        api: "https://example.com/path?api_key=secret",
        session: "https://example.com/path?token=secret",
        browser: "https://example.com/path?cookie=secret",
        invalid: "https://[invalid",
        public: "https://example.com/path?model=demo",
      }),
    ).toEqual({
      api: "***",
      session: "***",
      browser: "***",
      invalid: "***",
      public: "https://example.com/path?model=demo",
    })
  })

  test("redacts objects inside arrays and nested headers while preserving primitive values", () => {
    expect(
      redactConfig({
        providers: [{ apiKey: "array-secret", name: "demo" }],
        HEADERS: { nested: [{ "x-custom": "header-secret" }] },
        settings: [null, 1200, true, "demo"],
      }),
    ).toEqual({
      providers: [{ apiKey: "***", name: "demo" }],
      HEADERS: { nested: [{ "x-custom": "***" }] },
      settings: [null, 1200, true, "demo"],
    })
  })
})
