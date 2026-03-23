import { describe, test, expect } from "bun:test"
import { ConfigPaths } from "../../src/config/paths"
import { tmpdir } from "../fixture/fixture"
import * as fs from "fs/promises"
import path from "path"

describe("ConfigPaths.parseText: valid JSONC", () => {
  test("parses valid JSONC with trailing comma", async () => {
    const text = '{\n  "name": "test",\n  "value": 42,\n}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ name: "test", value: 42 })
  })

  test("parses JSONC with line comments", async () => {
    const text = '{\n  // a comment\n  "key": "val"\n}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ key: "val" })
  })
})

describe("ConfigPaths.parseText: JSONC error reporting", () => {
  test("throws JsonError with line and column for missing comma", async () => {
    // Missing comma between "name" and "value" properties
    const text = '{\n  "name": "test"\n  "value": 42\n}'
    await expect(ConfigPaths.parseText(text, "/fake/config.json")).rejects.toMatchObject({
      name: "ConfigJsonError",
      data: {
        path: "/fake/config.json",
      },
    })
    // Verify the error message includes position details
    try {
      await ConfigPaths.parseText(text, "/fake/config.json")
    } catch (e: any) {
      expect(e.data.message).toMatch(/line \d+/)
      expect(e.data.message).toMatch(/column \d+/)
    }
  })

  test("error message includes the offending line content", async () => {
    const text = '{\n  "a": [1, 2\n  "b": 3\n}'
    try {
      await ConfigPaths.parseText(text, "/fake/config.json")
      throw new Error("should have thrown")
    } catch (e: any) {
      if (e.message === "should have thrown") throw e
      // The error message should include the JSONC input and a caret marker
      expect(e.data.message).toContain("JSONC Input")
      expect(e.data.message).toContain("^")
    }
  })
})

describe("ConfigPaths.parseText: {env:} substitution", () => {
  test("replaces {env:VAR} with environment variable value", async () => {
    const prev = process.env["TEST_PARSE_TEXT_VAR"]
    process.env["TEST_PARSE_TEXT_VAR"] = "hello_world"
    try {
      const result = await ConfigPaths.parseText(
        '{ "key": "{env:TEST_PARSE_TEXT_VAR}" }',
        "/fake/config.json",
      )
      expect(result.key).toBe("hello_world")
    } finally {
      if (prev === undefined) delete process.env["TEST_PARSE_TEXT_VAR"]
      else process.env["TEST_PARSE_TEXT_VAR"] = prev
    }
  })

  test("replaces missing env var with empty string", async () => {
    delete process.env["DEFINITELY_MISSING_PARSE_TEXT_VAR_98765"]
    const result = await ConfigPaths.parseText(
      '{ "key": "{env:DEFINITELY_MISSING_PARSE_TEXT_VAR_98765}" }',
      "/fake/config.json",
    )
    expect(result.key).toBe("")
  })
})

describe("ConfigPaths.parseText: {file:} comment skipping", () => {
  test("skips {file:} tokens inside line comments", async () => {
    // If the comment-skip logic is broken, this would throw ENOENT
    const text = '{\n  // {file:nonexistent-file-that-does-not-exist.txt}\n  "key": "value"\n}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result.key).toBe("value")
  })
})

describe("ConfigPaths.parseText: {file:} missing file error", () => {
  test("throws InvalidError when referenced file does not exist", async () => {
    const text = '{ "key": "{file:/tmp/definitely-nonexistent-parse-text-file-abc123.txt}" }'
    await expect(ConfigPaths.parseText(text, "/fake/config.json")).rejects.toMatchObject({
      name: "ConfigInvalidError",
      data: {
        path: "/fake/config.json",
      },
    })
    // Verify specific error details
    try {
      await ConfigPaths.parseText(text, "/fake/config.json")
    } catch (e: any) {
      expect(e.data.message).toContain("does not exist")
    }
  })

  test("returns empty string for missing file when missing='empty'", async () => {
    const text = '{ "key": "{file:/tmp/definitely-nonexistent-parse-text-file-abc123.txt}" }'
    const result = await ConfigPaths.parseText(text, "/fake/config.json", "empty")
    expect(result.key).toBe("")
  })
})

describe("ConfigPaths.parseText: {file:} real file substitution", () => {
  test("substitutes {file:path} with actual file content", async () => {
    await using tmp = await tmpdir()
    const secretFile = path.join(tmp.path, "secret.txt")
    await fs.writeFile(secretFile, "my-secret-value")

    const text = `{ "apiKey": "{file:${secretFile}}" }`
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result.apiKey).toBe("my-secret-value")
  })

  test("trims whitespace from file content", async () => {
    await using tmp = await tmpdir()
    const secretFile = path.join(tmp.path, "secret.txt")
    await fs.writeFile(secretFile, "  my-value  \n")

    const text = `{ "apiKey": "{file:${secretFile}}" }`
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result.apiKey).toBe("my-value")
  })

  test("resolves relative {file:} paths against config directory", async () => {
    await using tmp = await tmpdir()
    const secretFile = path.join(tmp.path, "api-key.txt")
    await fs.writeFile(secretFile, "relative-secret")

    const configPath = path.join(tmp.path, "opencode.json")
    const text = '{ "apiKey": "{file:api-key.txt}" }'
    const result = await ConfigPaths.parseText(text, configPath)
    expect(result.apiKey).toBe("relative-secret")
  })
})
