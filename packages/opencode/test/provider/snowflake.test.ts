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
})

// ---------------------------------------------------------------------------
// Provider registration
// ---------------------------------------------------------------------------

describe("snowflake-cortex provider", () => {
  test("loads when SNOWFLAKE_ACCOUNT env var is set", async () => {
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
        expect(providers["snowflake-cortex"]).toBeDefined()
        expect(providers["snowflake-cortex"].options.baseURL).toBe(
          "https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1",
        )
      },
    })
  })

  test("does not load without credentials", async () => {
    // Auth reads from global auth.json; save and restore any real stored credentials
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
          // Env copies process.env per instance; remove any shell-level SNOWFLAKE_ACCOUNT
          Env.remove("SNOWFLAKE_ACCOUNT")
        },
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["snowflake-cortex"]).toBeUndefined()
        },
      })
    } finally {
      if (savedAuth) await Auth.set("snowflake-cortex", savedAuth)
    }
  })

  test("claude models have toolcall: true", async () => {
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
        const models = providers["snowflake-cortex"].models
        expect(models["claude-sonnet-4-6"].capabilities.toolcall).toBe(true)
        expect(models["claude-haiku-4-5"].capabilities.toolcall).toBe(true)
      },
    })
  })

  test("non-claude models have toolcall: false", async () => {
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
        const models = providers["snowflake-cortex"].models
        expect(models["mistral-large2"].capabilities.toolcall).toBe(false)
        expect(models["llama3.3-70b"].capabilities.toolcall).toBe(false)
        expect(models["deepseek-r1"].capabilities.toolcall).toBe(false)
      },
    })
  })

  test("all models have zero cost", async () => {
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
        for (const model of Object.values(providers["snowflake-cortex"].models)) {
          expect(model.cost.input).toBe(0)
          expect(model.cost.output).toBe(0)
        }
      },
    })
  })
})
