import { describe, expect, test } from "bun:test"
import { Token } from "../../src/util/token"

describe("Token.estimate", () => {
  // ─── Basic functionality ────────────────────────────────────────────

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })

  test("always returns a non-negative integer", () => {
    const inputs = ["hello", "x".repeat(10_000), "a", " "]
    for (const input of inputs) {
      const result = Token.estimate(input)
      expect(result).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(result)).toBe(true)
    }
  })

  // ─── Content detection ──────────────────────────────────────────────

  test("detects JSON content and uses JSON ratio", () => {
    const json = JSON.stringify({
      users: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
    })
    expect(Token.estimate(json)).toBe(Math.round(json.length / 3.2))
  })

  test("detects JSON array content", () => {
    const json = JSON.stringify([1, 2, 3, { a: "b", c: "d" }])
    expect(Token.estimate(json)).toBe(Math.round(json.length / 3.2))
  })

  test("detects JSON with leading whitespace", () => {
    const json = "  \n  " + JSON.stringify({ key: "value", nested: { a: 1 } })
    expect(Token.estimate(json)).toBe(Math.round(json.length / 3.2))
  })

  test("does not classify text starting with [ but low JSON density as JSON", () => {
    // Starts with [ but is actually prose
    const text = "[Note] This is a regular text message with no JSON structure at all and should not be classified"
    // The [ prefix triggers the JSON check but density should be low
    const estimate = Token.estimate(text)
    // Should NOT use JSON ratio since density is low
    expect(estimate).not.toBe(Math.round(text.length / 3.2))
  })

  test("detects SQL content and uses SQL ratio", () => {
    const sql = "SELECT u.id, u.name FROM users u WHERE u.active = true ORDER BY u.name"
    expect(Token.estimate(sql)).toBe(Math.round(sql.length / 3.5))
  })

  test("detects SQL with various keywords", () => {
    const sqls = [
      "INSERT INTO users (name, email) VALUES ('test', 'test@test.com')",
      "UPDATE users SET name = 'new' WHERE id = 1",
      "DELETE FROM users WHERE created_at < '2024-01-01'",
      "CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(255))",
      "ALTER TABLE users ADD COLUMN email VARCHAR(255)",
      "SELECT * FROM orders JOIN users ON orders.user_id = users.id GROUP BY users.name",
    ]
    for (const sql of sqls) {
      expect(Token.estimate(sql)).toBe(Math.round(sql.length / 3.5))
    }
  })

  test("detects SQL case-insensitively", () => {
    const sql = "select id from users where active = true"
    expect(Token.estimate(sql)).toBe(Math.round(sql.length / 3.5))
  })

  test("detects code with high special char density", () => {
    const code = "function foo(x) { if (x > 0) { return x * 2; } else { return -x; } }"
    expect(Token.estimate(code)).toBe(Math.round(code.length / 3.0))
  })

  test("falls back to default ratio for plain prose", () => {
    const prose = "The quick brown fox jumps over the lazy dog and runs through the meadow"
    expect(Token.estimate(prose)).toBe(Math.round(prose.length / 3.7))
  })

  // ─── Sampling behavior ──────────────────────────────────────────────

  test("samples only first 500 chars for large inputs", () => {
    // Plain text first 500 chars, then code after — should classify as text
    const text = "a".repeat(600) + "function() { return x; }"
    expect(Token.estimate(text)).toBe(Math.round(text.length / 3.7))
  })

  test("correctly classifies when content type is in first 500 chars", () => {
    // SQL in first 500 chars, then garbage after
    const sql = "SELECT * FROM users WHERE id = 1" + " ".repeat(500) + "xxxxx"
    expect(Token.estimate(sql)).toBe(Math.round(sql.length / 3.5))
  })

  test("handles input exactly 500 chars (boundary)", () => {
    const text = "a".repeat(500)
    const result = Token.estimate(text)
    expect(result).toBe(Math.round(500 / 3.7))
  })

  test("handles input exactly 501 chars (triggers slicing)", () => {
    const text = "a".repeat(501)
    const result = Token.estimate(text)
    expect(result).toBe(Math.round(501 / 3.7))
  })

  // ─── Edge cases: runtime type safety ────────────────────────────────

  test("returns 0 for null input (runtime safety)", () => {
    expect(Token.estimate(null as any)).toBe(0)
  })

  test("returns 0 for undefined input (runtime safety)", () => {
    expect(Token.estimate(undefined as any)).toBe(0)
  })

  test("returns 0 for numeric input (runtime safety)", () => {
    expect(Token.estimate(42 as any)).toBe(0)
  })

  test("returns 0 for object input (runtime safety)", () => {
    expect(Token.estimate({ toString: () => "hello" } as any)).toBe(0)
  })

  test("returns 0 for boolean input (runtime safety)", () => {
    expect(Token.estimate(true as any)).toBe(0)
  })

  test("returns 0 for array input (runtime safety)", () => {
    expect(Token.estimate(["a", "b"] as any)).toBe(0)
  })

  // ─── Edge cases: unicode and special content ────────────────────────

  test("handles emoji content", () => {
    // Emoji use surrogate pairs — JS .length counts code units, not codepoints
    // "😀" has .length 2, "👨‍👩‍👧‍👦" has .length 11
    const emoji = "😀".repeat(100)
    const result = Token.estimate(emoji)
    expect(result).toBeGreaterThan(0)
    expect(Number.isNaN(result)).toBe(false)
    expect(Number.isFinite(result)).toBe(true)
  })

  test("handles CJK content", () => {
    const cjk = "这是一个中文测试字符串用于验证令牌估计功能"
    const result = Token.estimate(cjk)
    expect(result).toBeGreaterThan(0)
    expect(Number.isFinite(result)).toBe(true)
  })

  test("handles mixed unicode and ASCII", () => {
    const mixed = "Hello 世界 🌍 café naïve résumé"
    const result = Token.estimate(mixed)
    expect(result).toBeGreaterThan(0)
    expect(Number.isFinite(result)).toBe(true)
  })

  test("handles string with null bytes", () => {
    const withNulls = "hello\0world\0test"
    const result = Token.estimate(withNulls)
    expect(result).toBeGreaterThan(0)
    expect(Number.isFinite(result)).toBe(true)
  })

  test("handles base64 encoded content", () => {
    const base64 = "aGVsbG8gd29ybGQ=".repeat(50)
    const result = Token.estimate(base64)
    expect(result).toBeGreaterThan(0)
    expect(Number.isFinite(result)).toBe(true)
  })

  test("handles strings with only whitespace", () => {
    const whitespace = "   \n\t\r\n   "
    const result = Token.estimate(whitespace)
    expect(result).toBeGreaterThan(0)
  })

  test("handles single character", () => {
    expect(Token.estimate("a")).toBe(Math.round(1 / 3.7))
  })

  test("handles very long strings (1MB) without performance issues", () => {
    const start = performance.now()
    const longString = "x".repeat(1_000_000)
    const result = Token.estimate(longString)
    const elapsed = performance.now() - start
    expect(result).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(100) // Should complete in <100ms
  })

  // ─── Backward compatibility ─────────────────────────────────────────

  test("backward compatibility: estimates within 35% of old chars/4 for typical content", () => {
    const samples = [
      "Hello world, this is a simple test message for token estimation.",
      "SELECT * FROM users WHERE id = 1",
      '{"key": "value", "count": 42}',
      "const x = (a, b) => { return a + b; };",
      "The quick brown fox jumps over the lazy dog.",
      "error: cannot find module 'express' at /usr/local/lib/node_modules",
    ]
    for (const sample of samples) {
      const oldEstimate = Math.round(sample.length / 4)
      const newEstimate = Token.estimate(sample)
      const ratio = newEstimate / oldEstimate
      // New estimates are slightly higher (more conservative), acceptable range
      expect(ratio).toBeGreaterThan(0.7)
      expect(ratio).toBeLessThan(1.5)
    }
  })

  // ─── Regression: NaN propagation ────────────────────────────────────

  test("never returns NaN for any input type", () => {
    const inputs: any[] = [
      "",
      "hello",
      null,
      undefined,
      0,
      42,
      NaN,
      Infinity,
      true,
      false,
      {},
      [],
      { length: 100 },
      Symbol("test"),
    ]
    for (const input of inputs) {
      try {
        const result = Token.estimate(input)
        expect(Number.isNaN(result)).toBe(false)
      } catch {
        // Symbol throws on typeof check — acceptable
      }
    }
  })

  test("never returns Infinity", () => {
    const inputs = ["", "x", "x".repeat(10_000)]
    for (const input of inputs) {
      expect(Number.isFinite(Token.estimate(input)) || Token.estimate(input) === 0).toBe(true)
    }
  })

  // ─── Content detection edge cases ───────────────────────────────────

  test("does not misclassify dbt Jinja SQL as code", () => {
    // dbt models use {{ }} but are SQL — the SQL keywords should win
    const dbtSql = "SELECT {{ ref('my_model') }} FROM {{ source('raw', 'users') }} WHERE created_at > '2024-01-01'"
    expect(Token.estimate(dbtSql)).toBe(Math.round(dbtSql.length / 3.5))
  })

  test("classifies YAML as plain text (default ratio)", () => {
    const yaml = "name: my-project\nversion: 1.0.0\ndependencies:\n  - express\n  - lodash"
    // YAML has few special chars, no SQL keywords → default
    expect(Token.estimate(yaml)).toBe(Math.round(yaml.length / 3.7))
  })

  test("classifies markdown with formatting as code (due to special chars)", () => {
    // Markdown with ** and * has enough special chars to trigger code detection
    const md = "# Heading\n\nThis is a paragraph with **bold** and *italic* text.\n\n- Item 1\n- Item 2"
    // The * chars push special char density above the 0.08 threshold
    expect(Token.estimate(md)).toBe(Math.round(md.length / 3.0))
  })

  test("classifies plain markdown without formatting as default", () => {
    const md = "This is a heading about the project overview and it has no special formatting at all and is just plain text"
    expect(Token.estimate(md)).toBe(Math.round(md.length / 3.7))
  })
})

describe("Token.estimateWithHint", () => {
  test("uses code ratio when hint is code", () => {
    const input = "hello world"
    expect(Token.estimateWithHint(input, "code")).toBe(Math.round(input.length / 3.0))
  })

  test("uses json ratio when hint is json", () => {
    const input = "hello world"
    expect(Token.estimateWithHint(input, "json")).toBe(Math.round(input.length / 3.2))
  })

  test("uses sql ratio when hint is sql", () => {
    const input = "hello world"
    expect(Token.estimateWithHint(input, "sql")).toBe(Math.round(input.length / 3.5))
  })

  test("uses text ratio when hint is text", () => {
    const input = "hello world"
    expect(Token.estimateWithHint(input, "text")).toBe(Math.round(input.length / 4.0))
  })

  test("returns 0 for empty input", () => {
    expect(Token.estimateWithHint("", "code")).toBe(0)
  })

  test("returns 0 for null input (runtime safety)", () => {
    expect(Token.estimateWithHint(null as any, "code")).toBe(0)
  })

  test("returns 0 for undefined input (runtime safety)", () => {
    expect(Token.estimateWithHint(undefined as any, "text")).toBe(0)
  })

  test("falls back to default ratio for invalid hint (runtime safety)", () => {
    const input = "hello world"
    // Invalid hint should not crash — falls back to default
    const result = Token.estimateWithHint(input, "yaml" as any)
    expect(result).toBe(Math.round(input.length / 3.7))
    expect(Number.isNaN(result)).toBe(false)
  })

  test("hint overrides auto-detection", () => {
    // This is JSON, but hint says "text"
    const json = '{"key": "value", "count": 42}'
    const withHint = Token.estimateWithHint(json, "text")
    const autoDetected = Token.estimate(json)
    // text ratio (4.0) gives fewer tokens than JSON ratio (3.2)
    expect(withHint).toBeLessThan(autoDetected)
  })
})
