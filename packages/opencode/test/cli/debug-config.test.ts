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

  test("masks all URL query values and malformed HTTP URLs", () => {
    expect(
      redactConfig({
        api: "https://example.com/path?api_key=secret",
        session: "https://example.com/path?token=secret",
        browser: "https://example.com/path?cookie=secret",
        invalid: "https://[invalid",
        public: "https://example.com/path?model=demo",
      }),
    ).toEqual({
      api: "https://example.com/path?api_key=***",
      session: "https://example.com/path?token=***",
      browser: "https://example.com/path?cookie=***",
      invalid: "***",
      public: "https://example.com/path?model=***",
    })
  })

  test.each(["key", "sig", "signature", "code"])("masks URL query value for %s", (key) => {
    expect(redactConfig({ endpoint: `https://example.com/path?${key}=secret` })).toEqual({
      endpoint: `https://example.com/path?${key}=***`,
    })
  })

  test("masks every query and fragment value, including repeated and empty values and bare query flags", () => {
    expect(
      redactConfig({
        endpoint: "https://example.com/path?model=demo&model=other&empty=&flag#state=ready&state=done&empty=",
      }),
    ).toEqual({
      endpoint: "https://example.com/path?model=***&model=***&empty=***&flag=***#state=***&state=***&empty=***",
    })
  })

  test("preserves URLs without parameters and fragment-only anchors", () => {
    const input = {
      plain: "https://example.com/path",
      plainJdbc: "jdbc:postgresql://example.com/database",
      plainOpaque: "custom:database",
      anchor: "https://example.com/path#section",
      namedAnchor: "https://example.com/path#access_token",
      jdbc: "jdbc:postgresql://example.com/database#section",
      opaque: "custom:database#section",
    }
    expect(redactConfig(input)).toEqual(input)
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

  test.each(["postgresql", "mysql", "mongodb+srv", "snowflake", "redis", "https", "custom+db"])(
    "masks %s URLs with username-only, password-only, or combined userinfo",
    (scheme) => {
      expect(
        redactConfig({
          withUser: `${scheme}://user@example.com/database`,
          withPass: `${scheme}://:pass@example.com/database`,
          withBoth: `${scheme}://user:pass@example.com/database`,
          public: `${scheme}://example.com/database?model=demo#section`,
        }),
      ).toEqual({
        withUser: "***",
        withPass: "***",
        withBoth: "***",
        public: `${scheme}://example.com/database?model=***#section`,
      })
    },
  )

  test("masks JDBC URL credentials and all JDBC and opaque URL parameter values", () => {
    expect(
      redactConfig({
        jdbcUser: "jdbc:postgresql://user@example.com/database",
        jdbcPass: "jdbc:mysql://:pass@example.com/database",
        jdbcBoth: "jdbc:postgresql://user:pass@example.com/database",
        jdbcQuery: "jdbc:postgresql://example.com/database?password=secret",
        jdbcFragment: "jdbc:mysql://example.com/database#access_token=secret",
        opaqueQuery: "custom:database?api_key=secret",
        opaqueFragment: "custom:database#session_token=secret",
        publicJdbc: "jdbc:postgresql://example.com/database?model=demo#section",
        publicOpaque: "custom:database?model=demo#section",
      }),
    ).toEqual({
      jdbcUser: "***",
      jdbcPass: "***",
      jdbcBoth: "***",
      jdbcQuery: "jdbc:postgresql://example.com/database?password=***",
      jdbcFragment: "jdbc:mysql://example.com/database#access_token=***",
      opaqueQuery: "custom:database?api_key=***",
      opaqueFragment: "custom:database#session_token=***",
      publicJdbc: "jdbc:postgresql://example.com/database?model=***#section",
      publicOpaque: "custom:database?model=***#section",
    })
  })

  test.each([
    "postgresql://user:pass@[invalid/database",
    "mysql://user:pass@example.com:invalid/database",
    "mongodb+srv://user:pass@[invalid/database",
    "snowflake://user:pass@[invalid/database",
    "redis://user:pass@[invalid/database",
    "https://user:pass@[invalid/path",
    "custom+db://user:pass@[invalid/database",
    "jdbc:postgresql://user:pass@[invalid/database",
  ])("masks userinfo in malformed URL %s", (url) => {
    expect(redactConfig({ endpoint: url })).toEqual({ endpoint: "***" })
  })

  test("preserves URL structure with @ outside the authority", () => {
    const input = {
      path: "https://example.com/users/@public",
      query: "mysql://example.com/database?email=public@example.com",
      fragment: "custom://example.com/database#email=public@example.com",
      jdbc: "jdbc:postgresql://example.com/database?email=public@example.com",
      malformed: "custom://[invalid/path@public",
    }
    expect(redactConfig(input)).toEqual({
      path: input.path,
      query: "mysql://example.com/database?email=***",
      fragment: "custom://example.com/database#email=***",
      jdbc: "jdbc:postgresql://example.com/database?email=***",
      malformed: input.malformed,
    })
  })

  test.each([
    "access_key",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "passwd",
    "bearer",
    "auth",
    "auth_config",
    "DOCKER_AUTH_CONFIG",
    "NPM_AUTH",
    "session_token",
    "client_secret",
    "dsn",
    "connection_string",
    "connectionString",
  ])("masks %s string keys and URL parameters while keeping non-string values", (key) => {
    expect(redactConfig({ [key]: "secret" })).toEqual({ [key]: "***" })
    expect(redactConfig({ [key]: 1200 })).toEqual({ [key]: 1200 })
    expect(redactConfig({ [key]: true })).toEqual({ [key]: true })
    expect(
      redactConfig({
        query: `mysql://example.com/database?model=demo&${key}=secret`,
        fragment: `https://example.com/path#state=demo&${key}=secret`,
      }),
    ).toEqual({
      query: `mysql://example.com/database?model=***&${key}=***`,
      fragment: `https://example.com/path#state=***&${key}=***`,
    })
  })

  test.each(["max_tokens", "maxTokens", "context_tokens", "tokenizer", "author", "authorize_url"])(
    "preserves non-secret %s strings in keys and argv while masking URL parameter values",
    (key) => {
      const input = {
        [key]: "public-value",
        query: `https://example.com/path?${key}=public-value`,
        fragment: `https://example.com/path#${key}=public-value`,
        command: ["example", `--${key}=public-value`, `-${key}=public-value`, `--${key}`, "public-value"],
      }
      expect(redactConfig(input)).toEqual({
        ...input,
        query: `https://example.com/path?${key}=***`,
        fragment: `https://example.com/path#${key}=***`,
      })
    },
  )

  test("checks strings in arrays and nested arrays without mutating resolved values", () => {
    const input = {
      endpoints: [
        "postgresql://user:pass@example.com/database",
        "redis://example.com/0?password=secret",
        "https://example.com/path#access_token=secret",
        "mysql://user:pass@[invalid/database",
        "jdbc:postgresql://user:pass@example.com/database",
        ["snowflake://user@example.com/database", "https://example.com/public"],
        null,
        1200,
        false,
        "demo",
      ],
      headers: { custom: ["header-secret", 1200, true, null] },
    }
    const before = structuredClone(input)
    expect(redactConfig(input)).toEqual({
      endpoints: [
        "***",
        "redis://example.com/0?password=***",
        "https://example.com/path#access_token=***",
        "***",
        "***",
        ["***", "https://example.com/public"],
        null,
        1200,
        false,
        "demo",
      ],
      headers: { custom: ["***", 1200, true, null] },
    })
    expect(input).toEqual(before)
    expect(redactConfig(["https://user:pass@example.com/path", "public"])).toEqual(["***", "public"])
  })

  test.each([
    "token",
    "password",
    "api-key",
    "access_key",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "passwd",
    "bearer",
    "auth",
    "DOCKER_AUTH_CONFIG",
    "NPM_AUTH",
    "session_token",
    "client_secret",
    "dsn",
    "connection_string",
    "connectionString",
  ])("masks inline and following values for secret argv flag %s", (flag) => {
    const input = {
      command: ["example", `--${flag}=inline-secret`, `-${flag}=inline-secret`, `--${flag}`, "next-secret"],
      nested: [[`-${flag}`, "next-secret", "public"]],
    }
    const before = structuredClone(input)
    expect(redactConfig(input)).toEqual({
      command: ["example", "***", "***", `--${flag}`, "***"],
      nested: [[`-${flag}`, "***", "public"]],
    })
    expect(input).toEqual(before)
  })

  test("preserves non-string argv values and limits bare flags to the following element", () => {
    expect(
      redactConfig({
        command: ["example", "--token", 1200, "public", "--password", false, "public", "--api-key", null, "public"],
        settings: ["--token", "secret", "public", "--password"],
        consecutive: ["--token", "--password", "secret", "public"],
      }),
    ).toEqual({
      command: ["example", "--token", 1200, "public", "--password", false, "public", "--api-key", null, "public"],
      settings: ["--token", "***", "public", "--password"],
      consecutive: ["--token", "***", "***", "public"],
    })
  })

  test("redacts every string nested under a secret-named key", () => {
    expect(
      redactConfig({
        token: ["opaque-secret"],
        credentials: { value: "opaque-secret", nested: { deeper: "opaque-secret" } },
        model: { name: "public" },
      }),
    ).toEqual({
      token: ["***"],
      credentials: { value: "***", nested: { deeper: "***" } },
      model: { name: "public" },
    })
  })
})
