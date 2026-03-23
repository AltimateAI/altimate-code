import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"
import { ConfigPaths } from "../../src/config/paths"

describe("ConfigPaths.parseText: {env:VAR} substitution", () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.TEST_DB_HOST = process.env.TEST_DB_HOST
    saved.TEST_EMPTY_VAR = process.env.TEST_EMPTY_VAR
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  test("replaces {env:VAR} with environment variable value", async () => {
    process.env.TEST_DB_HOST = "localhost"
    const result = await ConfigPaths.parseText(
      '{ "host": "{env:TEST_DB_HOST}" }',
      "/fake/config.json",
    )
    expect(result).toEqual({ host: "localhost" })
  })

  test("missing env var resolves to empty string", async () => {
    delete process.env.TEST_EMPTY_VAR
    const result = await ConfigPaths.parseText(
      '{ "key": "{env:TEST_EMPTY_VAR}" }',
      "/fake/config.json",
    )
    expect(result).toEqual({ key: "" })
  })
})

describe("ConfigPaths.parseText: {file:path} substitution", () => {
  test("inlines content from a relative file path", async () => {
    await using tmp = await tmpdir()
    const secretFile = path.join(tmp.path, "secret.txt")
    await fs.writeFile(secretFile, "my-api-key-123")
    const configPath = path.join(tmp.path, "opencode.json")

    const result = await ConfigPaths.parseText(
      '{ "apiKey": "{file:secret.txt}" }',
      configPath,
    )
    expect(result).toEqual({ apiKey: "my-api-key-123" })
  })

  test("inlines content from an absolute file path", async () => {
    await using tmp = await tmpdir()
    const secretFile = path.join(tmp.path, "abs-secret.txt")
    await fs.writeFile(secretFile, "absolute-key")

    const result = await ConfigPaths.parseText(
      `{ "apiKey": "{file:${secretFile}}" }`,
      "/fake/config.json",
    )
    expect(result).toEqual({ apiKey: "absolute-key" })
  })

  test("trims whitespace from file content", async () => {
    await using tmp = await tmpdir()
    const secretFile = path.join(tmp.path, "padded.txt")
    await fs.writeFile(secretFile, "  trimmed-value  \n")
    const configPath = path.join(tmp.path, "opencode.json")

    const result = await ConfigPaths.parseText(
      '{ "val": "{file:padded.txt}" }',
      configPath,
    )
    expect(result).toEqual({ val: "trimmed-value" })
  })

  test("throws ConfigInvalidError when referenced file does not exist", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")

    try {
      await ConfigPaths.parseText(
        '{ "apiKey": "{file:nonexistent.txt}" }',
        configPath,
      )
      expect.unreachable("should have thrown")
    } catch (err: any) {
      expect(err.name).toBe("ConfigInvalidError")
      expect(err.data.message).toContain("does not exist")
    }
  })

  test("missing file with mode 'empty' resolves to empty string", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")

    const result = await ConfigPaths.parseText(
      '{ "apiKey": "{file:nonexistent.txt}" }',
      configPath,
      "empty",
    )
    expect(result).toEqual({ apiKey: "" })
  })

  test("skips {file:...} inside JSONC comments", async () => {
    await using tmp = await tmpdir()
    const configPath = path.join(tmp.path, "opencode.json")

    // The {file:...} on a commented line should be left as-is and not cause an error
    const text = [
      "{",
      '  // {file:does-not-exist.txt}',
      '  "name": "test"',
      "}",
    ].join("\n")

    const result = await ConfigPaths.parseText(text, configPath)
    expect(result).toEqual({ name: "test" })
  })
})

describe("ConfigPaths.parseText: JSONC parsing", () => {
  test("parses valid JSONC with comments and trailing commas", async () => {
    const text = [
      "{",
      '  // This is a comment',
      '  "name": "test",',
      '  "count": 42,',
      "}",
    ].join("\n")

    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ name: "test", count: 42 })
  })

  test("throws ConfigJsonError with line/column on syntax error", async () => {
    const text = '{ "name": "test", "bad": }'

    try {
      await ConfigPaths.parseText(text, "/fake/bad.json")
      expect.unreachable("should have thrown")
    } catch (err: any) {
      expect(err.name).toBe("ConfigJsonError")
      expect(err.data.path).toBe("/fake/bad.json")
      // Error message should contain line and column info
      expect(err.data.message).toContain("line")
      expect(err.data.message).toContain("column")
    }
  })

  test("error message includes the problematic JSONC input", async () => {
    const text = '{ invalid json }'

    try {
      await ConfigPaths.parseText(text, "/fake/bad.json")
      expect.unreachable("should have thrown")
    } catch (err: any) {
      expect(err.name).toBe("ConfigJsonError")
      // The error message should include the input for debugging
      expect(err.data.message).toContain("JSONC Input")
      expect(err.data.message).toContain("invalid json")
    }
  })
})
