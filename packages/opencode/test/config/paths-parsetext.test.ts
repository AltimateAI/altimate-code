import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { ConfigPaths } from "../../src/config/paths"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

describe("ConfigPaths.parseText: JSONC parsing", () => {
  test("parses plain JSON object", async () => {
    const result = await ConfigPaths.parseText('{"key": "value"}', "/fake/config.json")
    expect(result).toEqual({ key: "value" })
  })

  test("parses JSONC with comments", async () => {
    const text = `{
      // This is a comment
      "key": "value"
    }`
    const result = await ConfigPaths.parseText(text, "/fake/config.jsonc")
    expect(result).toEqual({ key: "value" })
  })

  test("allows trailing commas", async () => {
    const text = '{"a": 1, "b": 2,}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ a: 1, b: 2 })
  })

  test("throws JsonError on invalid JSONC", async () => {
    const text = '{"key": value_without_quotes}'
    try {
      await ConfigPaths.parseText(text, "/fake/bad.json")
      expect.unreachable("should have thrown")
    } catch (e: any) {
      expect(e.constructor.name).toBe("ConfigJsonError")
      expect(e.data.path).toBe("/fake/bad.json")
    }
  })

  test("error message includes line and column info", async () => {
    const text = '{\n  "a": 1\n  "b": 2\n}'
    try {
      await ConfigPaths.parseText(text, "/fake/bad.json")
      expect.unreachable("should have thrown")
    } catch (e: any) {
      expect(e.data.message).toContain("line")
      expect(e.data.message).toContain("column")
    }
  })
})

describe("ConfigPaths.parseText: {env:VAR} substitution", () => {
  const envKey = "OPENCODE_TEST_PARSE_TEXT_KEY"

  beforeEach(() => {
    process.env[envKey] = "test-api-key-12345"
  })

  afterEach(() => {
    delete process.env[envKey]
  })

  test("substitutes {env:VAR} with environment variable value", async () => {
    const text = `{"apiKey": "{env:${envKey}}"}`
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ apiKey: "test-api-key-12345" })
  })

  test("substitutes to empty string when env var is not set", async () => {
    const text = '{"apiKey": "{env:OPENCODE_TEST_NONEXISTENT_VAR_XYZ}"}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ apiKey: "" })
  })

  test("substitutes multiple env vars in same text", async () => {
    process.env.OPENCODE_TEST_HOST = "localhost"
    process.env.OPENCODE_TEST_PORT = "5432"
    try {
      const text = '{"host": "{env:OPENCODE_TEST_HOST}", "port": "{env:OPENCODE_TEST_PORT}"}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      expect(result).toEqual({ host: "localhost", port: "5432" })
    } finally {
      delete process.env.OPENCODE_TEST_HOST
      delete process.env.OPENCODE_TEST_PORT
    }
  })

  test("env var substitution is raw text injection (not JSON-quoted)", async () => {
    process.env.OPENCODE_TEST_NUM = "42"
    try {
      // After env substitution, this becomes {"count": 42} — a number, not a string
      const text = '{"count": {env:OPENCODE_TEST_NUM}}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      expect(result).toEqual({ count: 42 })
    } finally {
      delete process.env.OPENCODE_TEST_NUM
    }
  })
})

describe("ConfigPaths.parseText: {file:path} substitution", () => {
  test("substitutes {file:path} with file contents (trimmed)", async () => {
    await using tmp = await tmpdir()
    const secretPath = path.join(tmp.path, "secret.txt")
    await fs.writeFile(secretPath, "my-secret-value\n")

    const text = `{"secret": "{file:${secretPath}}"}`
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ secret: "my-secret-value" })
  })

  test("resolves relative file path from config directory", async () => {
    await using tmp = await tmpdir()
    const secretPath = path.join(tmp.path, "creds.txt")
    await fs.writeFile(secretPath, "relative-secret")

    // source is the config file path — {file:creds.txt} resolves relative to its directory
    const configPath = path.join(tmp.path, "config.json")
    const text = '{"secret": "{file:creds.txt}"}'
    const result = await ConfigPaths.parseText(text, configPath)
    expect(result).toEqual({ secret: "relative-secret" })
  })

  test("throws InvalidError when referenced file does not exist", async () => {
    const text = '{"secret": "{file:/nonexistent/path/secret.txt}"}'
    try {
      await ConfigPaths.parseText(text, "/fake/config.json")
      expect.unreachable("should have thrown")
    } catch (e: any) {
      expect(e.constructor.name).toBe("ConfigInvalidError")
      expect(e.data.path).toBe("/fake/config.json")
      expect(e.data.message).toContain("does not exist")
    }
  })

  test("missing='empty' returns empty string for missing files", async () => {
    const text = '{"secret": "{file:/nonexistent/path/secret.txt}"}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json", "empty")
    expect(result).toEqual({ secret: "" })
  })

  test("skips {file:...} inside // comments", async () => {
    await using tmp = await tmpdir()
    // The file doesn't exist, but it's in a comment so should not trigger an error
    const text = `{
      // Reference: {file:nonexistent.txt}
      "key": "value"
    }`
    const result = await ConfigPaths.parseText(text, path.join(tmp.path, "config.json"))
    expect(result).toEqual({ key: "value" })
  })

  test("escapes file content for JSON safety (quotes and newlines)", async () => {
    await using tmp = await tmpdir()
    const secretPath = path.join(tmp.path, "multiline.txt")
    // Content with characters that need JSON escaping
    await fs.writeFile(secretPath, 'value with "quotes" and\nnewlines')

    const text = `{"secret": "{file:${secretPath}}"}`
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    // After file read → trim → JSON.stringify escape → parseJsonc, we get original content back
    expect(result.secret).toBe('value with "quotes" and\nnewlines')
  })
})

describe("ConfigPaths.parseText: combined substitutions", () => {
  test("handles both {env:} and {file:} in same config", async () => {
    await using tmp = await tmpdir()
    const secretPath = path.join(tmp.path, "db-pass.txt")
    await fs.writeFile(secretPath, "file-password")

    process.env.OPENCODE_TEST_DB_HOST = "db.example.com"
    try {
      const text = `{
        "host": "{env:OPENCODE_TEST_DB_HOST}",
        "password": "{file:${secretPath}}"
      }`
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      expect(result).toEqual({
        host: "db.example.com",
        password: "file-password",
      })
    } finally {
      delete process.env.OPENCODE_TEST_DB_HOST
    }
  })
})
