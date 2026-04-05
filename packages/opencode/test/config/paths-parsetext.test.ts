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

describe("ConfigPaths.parseText: ${VAR} substitution (shell/dotenv alias)", () => {
  const envKey = "OPENCODE_TEST_SHELL_SYNTAX_KEY"

  beforeEach(() => {
    process.env[envKey] = "shell-style-value"
  })

  afterEach(() => {
    delete process.env[envKey]
  })

  test("substitutes ${VAR} with environment variable value", async () => {
    const text = `{"apiKey": "\${${envKey}}"}`
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ apiKey: "shell-style-value" })
  })

  test("substitutes to empty string when env var is not set", async () => {
    const text = '{"apiKey": "${OPENCODE_TEST_SHELL_NONEXISTENT_XYZ}"}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ apiKey: "" })
  })

  test("${VAR} and {env:VAR} both work in same config", async () => {
    process.env.OPENCODE_TEST_MIXED_A = "alpha"
    process.env.OPENCODE_TEST_MIXED_B = "beta"
    try {
      const text = '{"a": "${OPENCODE_TEST_MIXED_A}", "b": "{env:OPENCODE_TEST_MIXED_B}"}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      expect(result).toEqual({ a: "alpha", b: "beta" })
    } finally {
      delete process.env.OPENCODE_TEST_MIXED_A
      delete process.env.OPENCODE_TEST_MIXED_B
    }
  })

  test("ignores ${...} with non-identifier names (spaces, special chars)", async () => {
    // These should pass through unmodified — not valid POSIX identifiers
    const text = '{"a": "${FOO BAR}", "b": "${foo-bar}", "c": "${foo.bar}"}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ a: "${FOO BAR}", b: "${foo-bar}", c: "${foo.bar}" })
  })

  test("does not match bare $VAR (without braces)", async () => {
    process.env.OPENCODE_TEST_BARE = "should-not-match"
    try {
      const text = '{"value": "$OPENCODE_TEST_BARE"}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      // Bare $VAR stays literal — only ${VAR} is interpolated
      expect(result).toEqual({ value: "$OPENCODE_TEST_BARE" })
    } finally {
      delete process.env.OPENCODE_TEST_BARE
    }
  })

  test("JSON-safe: env value with quotes cannot inject JSON structure", async () => {
    // Security regression test for C1 in consensus review of PR #655.
    // {env:VAR} is raw injection (backward compat); ${VAR} is string-safe.
    process.env.OPENCODE_TEST_INJECT = 'pwned", "isAdmin": true, "x": "y'
    try {
      const text = '{"token": "${OPENCODE_TEST_INJECT}"}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      // Value stays inside the "token" string — no injection into sibling keys
      expect(result).toEqual({ token: 'pwned", "isAdmin": true, "x": "y' })
      expect(result.isAdmin).toBeUndefined()
    } finally {
      delete process.env.OPENCODE_TEST_INJECT
    }
  })

  test("JSON-safe: env value with backslash and newline escaped properly", async () => {
    process.env.OPENCODE_TEST_MULTILINE = 'line1\nline2\tpath\\to\\file'
    try {
      const text = '{"value": "${OPENCODE_TEST_MULTILINE}"}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      expect(result).toEqual({ value: "line1\nline2\tpath\\to\\file" })
    } finally {
      delete process.env.OPENCODE_TEST_MULTILINE
    }
  })

  test("default: ${VAR:-default} uses default when var unset", async () => {
    // Variable is not set — default value should be used
    const text = '{"mode": "${OPENCODE_TEST_UNSET_VAR:-production}"}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ mode: "production" })
  })

  test("default: ${VAR:-default} uses env value when var set", async () => {
    process.env.OPENCODE_TEST_DEFAULT_OVERRIDE = "staging"
    try {
      const text = '{"mode": "${OPENCODE_TEST_DEFAULT_OVERRIDE:-production}"}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      expect(result).toEqual({ mode: "staging" })
    } finally {
      delete process.env.OPENCODE_TEST_DEFAULT_OVERRIDE
    }
  })

  test("default: ${VAR:-default} uses default when var is empty string", async () => {
    // POSIX :- uses default for both unset AND empty (matches docker-compose)
    process.env.OPENCODE_TEST_EMPTY_VAR = ""
    try {
      const text = '{"mode": "${OPENCODE_TEST_EMPTY_VAR:-fallback}"}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      expect(result).toEqual({ mode: "fallback" })
    } finally {
      delete process.env.OPENCODE_TEST_EMPTY_VAR
    }
  })

  test("default: empty default ${VAR:-} resolves to empty string", async () => {
    const text = '{"value": "${OPENCODE_TEST_EMPTY_DEFAULT:-}"}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ value: "" })
  })

  test("default: default value with spaces and special chars", async () => {
    const text = '{"msg": "${OPENCODE_TEST_MISSING:-Hello World 123}"}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result).toEqual({ msg: "Hello World 123" })
  })

  test("default: default value is JSON-escaped (security)", async () => {
    const text = '{"token": "${OPENCODE_TEST_MISSING:-pwned\\", \\"isAdmin\\": true, \\"x\\": \\"y}"}'
    const result = await ConfigPaths.parseText(text, "/fake/config.json")
    expect(result.token).toContain("pwned")
    expect(result.isAdmin).toBeUndefined()
  })

  test("escape hatch: $${VAR:-default} stays literal", async () => {
    process.env.OPENCODE_TEST_ESCAPED_DEFAULT = "should-not-be-used"
    try {
      const text = '{"template": "$${OPENCODE_TEST_ESCAPED_DEFAULT:-my-default}"}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      expect(result).toEqual({ template: "${OPENCODE_TEST_ESCAPED_DEFAULT:-my-default}" })
    } finally {
      delete process.env.OPENCODE_TEST_ESCAPED_DEFAULT
    }
  })

  test("escape hatch: $${VAR} stays literal (docker-compose convention)", async () => {
    process.env.OPENCODE_TEST_SHOULD_NOT_SUB = "interpolated"
    try {
      const text = '{"template": "$${OPENCODE_TEST_SHOULD_NOT_SUB}"}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      // $${VAR} → literal ${VAR}, env value is NOT substituted
      expect(result).toEqual({ template: "${OPENCODE_TEST_SHOULD_NOT_SUB}" })
    } finally {
      delete process.env.OPENCODE_TEST_SHOULD_NOT_SUB
    }
  })

  test("single-pass: {env:A} value containing ${B} stays literal (no cascade)", async () => {
    // Regression test for cubic/coderabbit P1: previously the {env:VAR} pass ran
    // first, then the ${VAR} pass expanded any ${...} in its output. Single-pass
    // substitution evaluates both patterns against the ORIGINAL text only.
    process.env.OPENCODE_TEST_CASCADE_A = "${OPENCODE_TEST_CASCADE_B}"
    process.env.OPENCODE_TEST_CASCADE_B = "should-not-expand"
    try {
      const text = '{"value": "{env:OPENCODE_TEST_CASCADE_A}"}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      // {env:VAR} is raw injection — its output is NOT re-interpolated
      expect(result.value).toBe("${OPENCODE_TEST_CASCADE_B}")
    } finally {
      delete process.env.OPENCODE_TEST_CASCADE_A
      delete process.env.OPENCODE_TEST_CASCADE_B
    }
  })

  test("single-pass: ${A} value containing {env:B} stays literal (no cascade)", async () => {
    // Reverse direction: ${VAR} output must not be matched by {env:VAR} pass.
    process.env.OPENCODE_TEST_CASCADE_C = "{env:OPENCODE_TEST_CASCADE_D}"
    process.env.OPENCODE_TEST_CASCADE_D = "should-not-expand"
    try {
      const text = '{"value": "${OPENCODE_TEST_CASCADE_C}"}'
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      expect(result.value).toBe("{env:OPENCODE_TEST_CASCADE_D}")
    } finally {
      delete process.env.OPENCODE_TEST_CASCADE_C
      delete process.env.OPENCODE_TEST_CASCADE_D
    }
  })

  test("works inside MCP environment config (issue #635 regression)", async () => {
    process.env.OPENCODE_TEST_GITLAB_TOKEN = "glpat-xxxxx"
    try {
      const text = `{
        "mcp": {
          "gitlab": {
            "type": "local",
            "command": ["npx", "-y", "@modelcontextprotocol/server-gitlab"],
            "environment": { "GITLAB_TOKEN": "\${OPENCODE_TEST_GITLAB_TOKEN}" }
          }
        }
      }`
      const result = await ConfigPaths.parseText(text, "/fake/config.json")
      expect(result.mcp.gitlab.environment.GITLAB_TOKEN).toBe("glpat-xxxxx")
    } finally {
      delete process.env.OPENCODE_TEST_GITLAB_TOKEN
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
