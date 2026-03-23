import { describe, test, expect } from "bun:test"
import { formatBytes, truncateQuery } from "../../../src/altimate/tools/finops-formatting"

describe("formatBytes: normal cases", () => {
  test("zero returns 0 B", () => {
    expect(formatBytes(0)).toBe("0 B")
  })

  test("exact unit boundaries", () => {
    expect(formatBytes(1)).toBe("1 B")
    expect(formatBytes(1024)).toBe("1.00 KB")
    expect(formatBytes(1024 * 1024)).toBe("1.00 MB")
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB")
  })

  test("non-boundary values", () => {
    expect(formatBytes(500)).toBe("500 B")
    expect(formatBytes(1536)).toBe("1.50 KB")
  })
})

describe("formatBytes: edge cases that expose bugs", () => {
  test("negative bytes produces NaN/undefined (known bug)", () => {
    // Users see "NaN undefined" when finops tools compute negative deltas
    // (e.g. comparing two periods where usage decreased)
    const result = formatBytes(-100)
    expect(result).toContain("NaN")
  })

  test("fractional bytes produces undefined unit (known bug)", () => {
    // Math.floor(Math.log(0.5) / Math.log(1024)) = -1, units[-1] is undefined
    const result = formatBytes(0.5)
    expect(result).toContain("undefined")
  })

  test("NaN input produces NaN output (known bug)", () => {
    const result = formatBytes(NaN)
    expect(result).toContain("NaN")
  })
})

describe("truncateQuery: normal cases", () => {
  test("empty/falsy input returns (empty)", () => {
    expect(truncateQuery("", 10)).toBe("(empty)")
  })

  test("short text returned as-is", () => {
    expect(truncateQuery("SELECT 1", 50)).toBe("SELECT 1")
  })

  test("long text truncated with ellipsis", () => {
    const long = "SELECT * FROM very_long_table_name WHERE id = 1"
    const result = truncateQuery(long, 20)
    expect(result.length).toBeLessThanOrEqual(20)
    expect(result).toEndWith("...")
  })

  test("multiline collapsed to single line", () => {
    const sql = "SELECT *\n  FROM table\n  WHERE id = 1"
    expect(truncateQuery(sql, 100)).toBe("SELECT * FROM table WHERE id = 1")
  })
})

describe("truncateQuery: edge cases that expose bugs", () => {
  test("whitespace-only returns empty string instead of (empty) (known bug)", () => {
    // "   " is truthy so the `if (!text)` guard is skipped.
    // After `.replace(/\s+/g, " ").trim()` it becomes "".
    // The length check `0 <= 10` passes, returning the empty string directly.
    expect(truncateQuery("   ", 10)).toBe("")
  })

  test("maxLen smaller than 3 produces string longer than maxLen (known bug)", () => {
    // slice(0, 2-3) = slice(0, -1) keeps most of the string, then "..." is appended
    const result = truncateQuery("hello world", 2)
    expect(result.length).toBeGreaterThan(2)
    // Actual output is "hello worl..." (13 chars) — far exceeds the 2-char limit
    expect(result).toBe("hello worl...")
  })
})
