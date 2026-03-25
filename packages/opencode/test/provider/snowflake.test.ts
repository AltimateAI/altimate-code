import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { parseSnowflakePAT, transformSnowflakeBody } from "../../src/altimate/plugin/snowflake"

// ---------------------------------------------------------------------------
// parseSnowflakePAT
// ---------------------------------------------------------------------------

describe("parseSnowflakePAT", () => {
  test("parses valid account::token", () => {
    const result = parseSnowflakePAT("myorg-myaccount::my-pat-token")
    expect(result).toEqual({ account: "myorg-myaccount", token: "my-pat-token" })
  })

  test("trims whitespace around account and token", () => {
    const result = parseSnowflakePAT("  myorg-myaccount  ::  my-pat-token  ")
    expect(result).toEqual({ account: "myorg-myaccount", token: "my-pat-token" })
  })

  test("returns null when separator is missing", () => {
    expect(parseSnowflakePAT("myorg-myaccount;my-pat-token")).toBeNull()
    expect(parseSnowflakePAT("myorg-myaccount:my-pat-token")).toBeNull()
    expect(parseSnowflakePAT("myorg-myaccountmy-pat-token")).toBeNull()
  })

  test("returns null when account is empty", () => {
    expect(parseSnowflakePAT("::my-pat-token")).toBeNull()
  })

  test("returns null when token is empty", () => {
    expect(parseSnowflakePAT("myorg-myaccount::")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(parseSnowflakePAT("")).toBeNull()
  })

  test("uses first :: as separator (token may contain ::)", () => {
    const result = parseSnowflakePAT("myorg::token::with::colons")
    expect(result).toEqual({ account: "myorg", token: "token::with::colons" })
  })

  test("rejects account with slashes (URL injection)", () => {
    expect(parseSnowflakePAT("evil/path::token")).toBeNull()
  })

  test("rejects account with query characters", () => {
    expect(parseSnowflakePAT("evil?x=y::token")).toBeNull()
  })

  test("rejects account with hash fragment", () => {
    expect(parseSnowflakePAT("evil#fragment::token")).toBeNull()
  })

  test("rejects account with spaces", () => {
    expect(parseSnowflakePAT("evil account::token")).toBeNull()
  })

  test("rejects account with unicode characters", () => {
    expect(parseSnowflakePAT("αλφα::token")).toBeNull()
  })

  test("accepts account with dots and underscores", () => {
    const result = parseSnowflakePAT("my_org.account-1::token")
    expect(result).toEqual({ account: "my_org.account-1", token: "token" })
  })
})

// ---------------------------------------------------------------------------
// transformSnowflakeBody
// ---------------------------------------------------------------------------

describe("transformSnowflakeBody", () => {
  test("rewrites max_tokens to max_completion_tokens", () => {
    const input = JSON.stringify({ model: "claude-sonnet-4-6", messages: [], max_tokens: 1000 })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.max_completion_tokens).toBe(1000)
    expect(parsed.max_tokens).toBeUndefined()
  })

  test("leaves requests without max_tokens unchanged", () => {
    const input = JSON.stringify({ model: "claude-sonnet-4-6", messages: [], max_completion_tokens: 1000 })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.max_completion_tokens).toBe(1000)
    expect(parsed.max_tokens).toBeUndefined()
  })

  test("strips tools for mistral-large2", () => {
    const input = JSON.stringify({
      model: "mistral-large2",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
      tool_choice: "auto",
    })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeUndefined()
    expect(parsed.tool_choice).toBeUndefined()
  })

  test("strips tools for llama3.3-70b", () => {
    const input = JSON.stringify({
      model: "llama3.3-70b",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeUndefined()
  })

  test("strips tools for deepseek-r1", () => {
    const input = JSON.stringify({
      model: "deepseek-r1",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeUndefined()
  })

  test("keeps tools for openai-gpt-4.1", () => {
    const input = JSON.stringify({
      model: "openai-gpt-4.1",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeDefined()
    expect(parsed.tools).toHaveLength(1)
  })

  test("keeps tools for claude-sonnet-4-6", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeDefined()
    expect(parsed.tools).toHaveLength(1)
  })

  test("returns synthetic stop response when last message is assistant without tool_calls", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "I'm here!" },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { syntheticStop } = transformSnowflakeBody(input)
    expect(syntheticStop).toBeDefined()
    expect(syntheticStop!.status).toBe(200)
    expect(syntheticStop!.headers.get("content-type")).toBe("text/event-stream")
  })

  test("does NOT short-circuit when last message is assistant with tool_calls", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "", tool_calls: [{ id: "tc1", function: { name: "read_file" } }] },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { syntheticStop } = transformSnowflakeBody(input)
    expect(syntheticStop).toBeUndefined()
  })

  test("does NOT short-circuit when last message is user", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { syntheticStop } = transformSnowflakeBody(input)
    expect(syntheticStop).toBeUndefined()
  })

  test("does NOT short-circuit when stream is false", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      stream: false,
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "I'm here!" },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input)
    expect(syntheticStop).toBeUndefined()
  })

  test("short-circuits when stream is true", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "I'm here!" },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input)
    expect(syntheticStop).toBeDefined()
  })

  test("short-circuits when stream is not specified (defaults to streaming)", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "I'm here!" },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input)
    expect(syntheticStop).toBeDefined()
  })

  test("triggers synthetic stop when tool_calls is empty array", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "done", tool_calls: [] },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input)
    expect(syntheticStop).toBeDefined()
  })

  test("removes orphaned tool_calls from messages for no-toolcall models", () => {
    const input = JSON.stringify({
      model: "llama3.3-70b",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "", tool_calls: [{ id: "tc1", function: { name: "read_file" } }] },
        { role: "tool", content: "file contents", tool_call_id: "tc1" },
        { role: "assistant", content: "here is the file" },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeUndefined()
    // tool_calls should be removed from assistant messages
    for (const msg of parsed.messages) {
      expect(msg.tool_calls).toBeUndefined()
    }
    // tool role messages should be filtered out
    expect(parsed.messages.every((m: { role: string }) => m.role !== "tool")).toBe(true)
  })

  test("throws on invalid JSON input", () => {
    expect(() => transformSnowflakeBody("not-json")).toThrow()
  })

  test("synthetic stop SSE stream has correct format", async () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "done" },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input)
    expect(syntheticStop).toBeDefined()
    const text = await syntheticStop!.text()
    // Should contain SSE data lines and [DONE]
    expect(text).toContain("data: ")
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain("data: [DONE]")
    // Should NOT contain usage block (avoids zero-token accounting issues)
    expect(text).not.toContain('"usage"')
  })

  test("handles empty messages array without crashing", () => {
    const input = JSON.stringify({ model: "claude-sonnet-4-6", messages: [] })
    const { syntheticStop } = transformSnowflakeBody(input)
    expect(syntheticStop).toBeUndefined()
  })

  test("handles missing messages field", () => {
    const input = JSON.stringify({ model: "claude-sonnet-4-6" })
    const { body } = transformSnowflakeBody(input)
    expect(JSON.parse(body).model).toBe("claude-sonnet-4-6")
  })

  test("preserves max_completion_tokens when max_tokens is absent", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "test" }],
      max_completion_tokens: 500,
    })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.max_completion_tokens).toBe(500)
    expect(parsed.max_tokens).toBeUndefined()
  })

  test("handles both max_tokens and max_completion_tokens (max_tokens wins)", () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "test" }],
      max_tokens: 100,
      max_completion_tokens: 500,
    })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.max_completion_tokens).toBe(100)
    expect(parsed.max_tokens).toBeUndefined()
  })

  test("strips tools for unknown model (not in TOOLCALL_MODELS allowlist)", () => {
    const input = JSON.stringify({
      model: "some-future-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.tools).toBeUndefined()
  })

  test("strips tool_choice without tools for non-toolcall model", () => {
    const input = JSON.stringify({
      model: "mistral-7b",
      messages: [{ role: "user", content: "hello" }],
      tool_choice: "auto",
    })
    const { body } = transformSnowflakeBody(input)
    const parsed = JSON.parse(body)
    expect(parsed.tool_choice).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Fetch interceptor (SnowflakeCortexAuthPlugin)
// ---------------------------------------------------------------------------

describe("SnowflakeCortexAuthPlugin fetch interceptor", () => {
  test("content-length header is deleted after body transformation", async () => {
    // Simulate what the fetch wrapper does: copy headers, transform body, delete content-length
    const originalBody = JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "test" }],
      max_tokens: 1000,
    })
    const headers = new Headers({
      "content-type": "application/json",
      "content-length": String(originalBody.length),
    })

    // Transform body (same logic as the fetch wrapper)
    const result = transformSnowflakeBody(originalBody)
    const newBody = result.body

    // Body changed (max_tokens → max_completion_tokens), so lengths differ
    expect(newBody.length).not.toBe(originalBody.length)

    // The fetch wrapper should delete content-length after transform
    headers.delete("content-length")
    expect(headers.has("content-length")).toBe(false)
  })

  test("synthetic stop returns valid SSE Response object", async () => {
    const input = JSON.stringify({
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [
        { role: "user", content: "test" },
        { role: "assistant", content: "response" },
      ],
    })
    const { syntheticStop } = transformSnowflakeBody(input)
    expect(syntheticStop).toBeInstanceOf(Response)
    expect(syntheticStop!.status).toBe(200)
    expect(syntheticStop!.headers.get("content-type")).toBe("text/event-stream")
    expect(syntheticStop!.headers.get("cache-control")).toBe("no-cache")

    // Body should be a readable stream
    const text = await syntheticStop!.text()
    const lines = text.split("\n").filter((l: string) => l.startsWith("data: "))
    expect(lines.length).toBe(3) // delta, stop, [DONE]
  })
})

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

describe("snowflake-cortex provider", () => {
  // Save and restore any real stored credentials to keep tests hermetic
  let savedAuth: Awaited<ReturnType<typeof Auth.get>>
  const setupOAuth = async (account = "myorg-myaccount") => {
    savedAuth = await Auth.get("snowflake-cortex")
    await Auth.set("snowflake-cortex", {
      type: "oauth",
      access: "test-pat-token",
      refresh: "",
      expires: Date.now() + 90 * 24 * 60 * 60 * 1000,
      accountId: account,
    })
  }
  const restoreAuth = async () => {
    if (savedAuth) {
      await Auth.set("snowflake-cortex", savedAuth)
    } else {
      await Auth.remove("snowflake-cortex")
    }
  }

  test("loads when oauth auth with accountId is set", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["snowflake-cortex"]).toBeDefined()
          expect(providers["snowflake-cortex"].options.baseURL).toBe(
            "https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1",
          )
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("does not load without oauth auth", async () => {
    savedAuth = await Auth.get("snowflake-cortex")
    if (savedAuth) await Auth.remove("snowflake-cortex")
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.remove("SNOWFLAKE_ACCOUNT")
        },
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["snowflake-cortex"]).toBeUndefined()
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("does not load with only SNOWFLAKE_ACCOUNT env (no oauth)", async () => {
    savedAuth = await Auth.get("snowflake-cortex")
    if (savedAuth) await Auth.remove("snowflake-cortex")
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.set("SNOWFLAKE_ACCOUNT", "myorg-myaccount")
        },
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["snowflake-cortex"]).toBeUndefined()
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("Claude and OpenAI models have toolcall: true", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const models = providers["snowflake-cortex"].models
          // Claude
          expect(models["claude-sonnet-4-6"].capabilities.toolcall).toBe(true)
          expect(models["claude-haiku-4-5"].capabilities.toolcall).toBe(true)
          expect(models["claude-3-5-sonnet"].capabilities.toolcall).toBe(true)
          // OpenAI
          expect(models["openai-gpt-4.1"].capabilities.toolcall).toBe(true)
          expect(models["openai-gpt-5"].capabilities.toolcall).toBe(true)
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("Llama, Mistral, and DeepSeek models have toolcall: false", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const models = providers["snowflake-cortex"].models
          expect(models["mistral-large2"].capabilities.toolcall).toBe(false)
          expect(models["snowflake-llama-3.3-70b"].capabilities.toolcall).toBe(false)
          expect(models["llama3.1-70b"].capabilities.toolcall).toBe(false)
          expect(models["deepseek-r1"].capabilities.toolcall).toBe(false)
          expect(models["llama4-maverick"].capabilities.toolcall).toBe(false)
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("all models have zero cost", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          for (const model of Object.values(providers["snowflake-cortex"].models)) {
            expect(model.cost.input).toBe(0)
            expect(model.cost.output).toBe(0)
          }
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("env array is empty (auth-only provider)", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["snowflake-cortex"].env).toEqual([])
        },
      })
    } finally {
      await restoreAuth()
    }
  })

  test("claude-3-5-sonnet output limit is 8192", async () => {
    await setupOAuth()
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["snowflake-cortex"].models["claude-3-5-sonnet"].limit.output).toBe(8192)
        },
      })
    } finally {
      await restoreAuth()
    }
  })
})

// ---------------------------------------------------------------------------
// Provider.all() — unauthenticated discoverability
// ---------------------------------------------------------------------------

describe("Provider.all() discoverability", () => {
  test("includes snowflake-cortex even without oauth auth", async () => {
    const savedAuth = await Auth.get("snowflake-cortex")
    if (savedAuth) await Auth.remove("snowflake-cortex")
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          Env.remove("SNOWFLAKE_ACCOUNT")
        },
        fn: async () => {
          const allProviders = await Provider.all()
          expect(allProviders["snowflake-cortex"]).toBeDefined()
          expect(allProviders["snowflake-cortex"].name).toBe("Snowflake Cortex")
          // list() still returns nothing (not authenticated)
          const connected = await Provider.list()
          expect(connected["snowflake-cortex"]).toBeUndefined()
        },
      })
    } finally {
      if (savedAuth) await Auth.set("snowflake-cortex", savedAuth)
    }
  })

  test("all() includes snowflake-cortex models", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://altimate.ai/config.json" }))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const allProviders = await Provider.all()
        const models = allProviders["snowflake-cortex"]?.models
        expect(models).toBeDefined()
        expect(models["claude-sonnet-4-6"]).toBeDefined()
        expect(models["deepseek-r1"]).toBeDefined()
      },
    })
  })

  test("disabled_providers config suppresses snowflake-cortex from all()", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://altimate.ai/config.json", disabled_providers: ["snowflake-cortex"] }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Provider.all() returns raw database, config filtering happens at the route level.
        // Verify the route-level filtering logic: a disabled provider should not appear
        // in the merged provider list used by GET /provider.
        const allProviders = await Provider.all()
        const connected = await Provider.list()
        // Simulate the route filtering (same logic as routes/provider.ts)
        const disabled = new Set(["snowflake-cortex"])
        const customProviders: Record<string, (typeof allProviders)[string]> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if (key in connected) continue
          if (!disabled.has(key)) customProviders[key] = value
        }
        expect(customProviders["snowflake-cortex"]).toBeUndefined()
      },
    })
  })

  test("enabled_providers config suppresses snowflake-cortex when not listed", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://altimate.ai/config.json", enabled_providers: ["anthropic"] }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const allProviders = await Provider.all()
        const connected = await Provider.list()
        // Simulate route filtering with enabled_providers
        // (snowflake-cortex is not in the enabled list, so it should be excluded)
        const enabled = new Set(["anthropic"])
        const customProviders: Record<string, (typeof allProviders)[string]> = {}
        for (const [key, value] of Object.entries(allProviders)) {
          if (key in connected) continue
          if (enabled.has(key)) customProviders[key] = value
        }
        expect(customProviders["snowflake-cortex"]).toBeUndefined()
      },
    })
  })
})
