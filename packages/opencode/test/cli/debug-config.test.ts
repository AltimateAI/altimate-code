import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
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
        local: { environment: { SERVICE_TOKEN: "***", PATH: "***" } },
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
      api: "https://example.com/***",
      session: "https://example.com/path?token=***",
      browser: "https://example.com/path?cookie=***",
      invalid: "***",
      public: "https://example.com/path?model=***",
    })
  })

  test.each([
    "https://[invalid/mcp?api_key=secret",
    "https://[invalid/mcp?token=secret",
    "https://user:pass@[invalid/mcp",
    "https://user:pass@[invalid/mcp?token=secret",
    "custom://[invalid/mcp?api_key=secret",
    "custom://[invalid/mcp?token=secret",
    "custom://user:pass@[invalid/mcp",
    "custom://user:pass@[invalid/mcp?token=secret",
    "//user:pass@[invalid/mcp?api_key=secret",
  ])("fails closed for malformed URL %s with surrounding whitespace", (url) => {
    for (const value of [url, ` ${url}`, `${url} `, ` \t${url}\r\n `]) {
      expect(redactConfig({ endpoint: value })).toEqual({ endpoint: "***" })
    }
  })

  test.each(["key", "sig", "signature", "code"])("masks URL query value for %s", (key) => {
    expect(redactConfig({ link: `https://example.com/path?${key}=secret` })).toEqual({
      link: `https://example.com/path?${key}=***`,
    })
  })

  test("masks every query and fragment value, including repeated and empty values and bare query flags", () => {
    expect(
      redactConfig({
        link: "https://example.com/path?model=demo&model=other&empty=&flag#state=ready&state=done&empty=",
      }),
    ).toEqual({
      link: "https://example.com/path?model=***&model=***&empty=***&flag=***#state=***&state=***&empty=***",
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

  test("handles whitespace around valid URLs without changing unrelated strings", () => {
    const input = {
      plain: " \thttps://example.com/path\r\n ",
      query: " \thttps://example.com/path?api_key=secret",
      jdbc: " \tjdbc:postgresql://user:pass@example.com/database\r\n ",
      label: " padded text ",
    }
    expect(redactConfig(input)).toEqual({
      plain: input.plain,
      query: " \thttps://example.com/path?api_key=***",
      jdbc: "***",
      label: input.label,
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
      malformed: "***",
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
        argv: ["example", `--${key}=public-value`, `-${key}=public-value`, `--${key}`, "public-value"],
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
      argv: ["example", `--${flag}=inline-secret`, `-${flag}=inline-secret`, `--${flag}`, "next-secret"],
      nested: [[`-${flag}`, "next-secret", "public"]],
    }
    const before = structuredClone(input)
    expect(redactConfig(input)).toEqual({
      argv: ["example", "***", "***", `--${flag}`, "***"],
      nested: [[`-${flag}`, "***", "public"]],
    })
    expect(input).toEqual(before)
  })

  test("preserves non-string argv values and limits bare flags to the following element", () => {
    expect(
      redactConfig({
        argv: ["example", "--token", 1200, "public", "--password", false, "public", "--api-key", null, "public"],
        settings: ["--token", "secret", "public", "--password"],
        consecutive: ["--token", "--password", "secret", "public"],
      }),
    ).toEqual({
      argv: ["example", "--token", 1200, "public", "--password", false, "public", "--api-key", null, "public"],
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

  test.each(["command", "headersCommand", "args"])(
    "keeps only the first element and non-string values in %s",
    (key) => {
      expect(
        redactConfig({
          [key]: ["example", "--max_tokens=1200", "public", "--token", "--verbose", "-v", 1200, false, null],
        }),
      ).toEqual({
        [key]: ["example", "***", "***", "***", "***", "***", 1200, false, null],
      })
    },
  )

  test("keeps only the executable in headersCommand records and masks non-array values", () => {
    expect(
      redactConfig({
        headersCommand: {
          "X-Tenant": ["sh", "-c", "printf embedded-secret"],
          "X-String": "embedded-secret",
          "X-Number": 1200,
          "X-Null": null,
        },
      }),
    ).toEqual({
      headersCommand: {
        "X-Tenant": ["sh", "***", "***"],
        "X-String": "***",
        "X-Number": "***",
        "X-Null": "***",
      },
    })
  })

  test("redacts schema-valid MCP URLs and headersCommand without changing custom commands", () => {
    const command = {
      review: {
        template: "Review the changes in $ARGUMENTS",
        model: "test/test-model",
        agent: "build",
        description: "Review local changes",
        subtask: true,
      },
    }
    const input = Schema.decodeUnknownSync(ConfigV1.Info)({
      command,
      mcp: {
        query: {
          type: "remote",
          url: " https://[invalid/mcp?api_key=query-secret ",
          headersCommand: { Authorization: ["sh", "-c", "printf header-secret"] },
        },
        userinfo: { type: "remote", url: " custom://user:pass@[invalid/mcp?token=query-secret " },
      },
    })
    expect(redactConfig(input)).toEqual({
      command,
      mcp: {
        query: { type: "remote", url: "***", headersCommand: { Authorization: ["sh", "***", "***"] } },
        userinfo: { type: "remote", url: "***" },
      },
    })
  })

  test("masks secrets attached to short command flags", () => {
    expect(redactConfig({ command: ["mysql", "-pSecret123"] })).toEqual({ command: ["mysql", "***"] })
  })

  test.each(["environment", "env"])("masks nested strings under %s while preserving non-string values", (key) => {
    expect(
      redactConfig({
        [key]: { nested: ["debug", 1200, true, null], command: ["example", "--verbose"] },
      }),
    ).toEqual({
      [key]: { nested: ["***", 1200, true, null], command: ["***", "***"] },
    })
  })

  test("masks every MCP environment value and keeps only the executable in command arrays", () => {
    expect(
      redactConfig({
        mcp: {
          db: {
            type: "local",
            command: ["env", "API_TOKEN=secret", "curl", "--header", "Authorization: Bearer secret", "--verbose"],
            environment: {
              DATABASE_URL: "jdbc:sqlserver://db;user=sa;password=Secret123",
              ORACLE: "jdbc:oracle:thin:scott/tiger@db:1521/orcl",
              KEY_PASSPHRASE: "also-secret",
              DB_PWD: "hunter2",
              LOG_LEVEL: "debug",
            },
          },
        },
        other: { KEY_PASSPHRASE: "x", DB_PWD: "y", password_hint_url: "https://example.com/help" },
      }),
    ).toEqual({
      mcp: {
        db: {
          type: "local",
          command: ["env", "***", "***", "***", "***", "***"],
          environment: {
            DATABASE_URL: "***",
            ORACLE: "***",
            KEY_PASSPHRASE: "***",
            DB_PWD: "***",
            LOG_LEVEL: "***",
          },
        },
      },
      other: { KEY_PASSPHRASE: "***", DB_PWD: "***", password_hint_url: "***" },
    })
  })
})

describe("remote server URLs and prose", () => {
  test("prints only the origin of a remote MCP url, since paths can carry credentials", () => {
    expect(
      redactConfig({
        mcp: {
          make: { type: "remote", url: "https://eu2.make.com/mcp/u/path-secret/stateless" },
          query: { type: "remote", url: "https://mcp.example.com/sse?token=query-secret" },
          bare: { type: "remote", url: "https://mcp.example.com" },
        },
      }),
    ).toEqual({
      mcp: {
        make: { type: "remote", url: "https://eu2.make.com/***" },
        query: { type: "remote", url: "https://mcp.example.com/***" },
        bare: { type: "remote", url: "https://mcp.example.com" },
      },
    })
  })

  test("still redacts a URL whose query contains spaces", () => {
    expect(redactConfig({ options: { link: "https://example.com/v1?api_key=secret&label=hello world" } })).toEqual({
      options: { link: "https://example.com/v1?api_key=***&label=***" },
    })
  })

  test.each([
    "https:/api.example.com/v1?api_key=secret&label=hello world",
    "jdbc:postgresql://db.example.com/app?password=secret&app=my app",
  ])("redacts scheme-prefixed value %s even with spaces", (url) => {
    expect(JSON.stringify(redactConfig({ options: { baseURL: url } }))).not.toContain("secret")
  })

  test("keeps prose that starts with a label", () => {
    const prompt = "Review: check {file} carefully, see https://example.com/docs?x=1"
    expect(redactConfig({ agent: { review: { prompt } } })).toEqual({ agent: { review: { prompt } } })
  })

  test("masks unparseable endpoint values entirely", () => {
    expect(redactConfig({ mcp: { remote: { type: "remote", url: "mcp.example.com/mcp/u/path-secret" } } })).toEqual({
      mcp: { remote: { type: "remote", url: "***" } },
    })
  })

  test("prints only the origin of provider endpoint URLs", () => {
    expect(
      redactConfig({
        provider: {
          custom: { api: "https://gateway.example/v1/sk-secret", options: { baseURL: "https://proxy.example.com/path-secret/v1" } },
        },
      }),
    ).toEqual({
      provider: { custom: { api: "https://gateway.example/***", options: { baseURL: "https://proxy.example.com/***" } } },
    })
  })

  test("keeps prose that mentions a link", () => {
    const prompt = "See https://example.com/docs before answering."
    expect(redactConfig({ agent: { review: { prompt } } })).toEqual({ agent: { review: { prompt } } })
  })
})
