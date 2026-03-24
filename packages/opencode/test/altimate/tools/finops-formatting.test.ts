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

describe("formatBytes: higher units (TB, PB)", () => {
  test("TB boundary", () => {
    expect(formatBytes(1024 ** 4)).toBe("1.00 TB")
  })

  test("PB boundary", () => {
    expect(formatBytes(1024 ** 5)).toBe("1.00 PB")
  })

  test("values beyond PB stay at PB (no EB unit)", () => {
    expect(formatBytes(1024 ** 6)).toBe("1024.00 PB")
  })

  test("multi-PB value", () => {
    expect(formatBytes(2 * 1024 ** 5)).toBe("2.00 PB")
  })
})

describe("formatBytes: edge cases", () => {
  test("negative bytes displays with sign", () => {
    expect(formatBytes(-100)).toBe("-100 B")
    expect(formatBytes(-1536)).toBe("-1.50 KB")
  })

  test("negative KB", () => {
    expect(formatBytes(-1024)).toBe("-1.00 KB")
  })

  test("fractional bytes clamps to B unit", () => {
    expect(formatBytes(0.5)).toBe("1 B")
  })

  test("NaN input returns 0 B", () => {
    expect(formatBytes(NaN)).toBe("0 B")
  })

  test("Infinity input returns 0 B", () => {
    expect(formatBytes(Infinity)).toBe("0 B")
    expect(formatBytes(-Infinity)).toBe("0 B")
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

describe("truncateQuery: edge cases", () => {
  test("whitespace-only returns (empty)", () => {
    expect(truncateQuery("   ", 10)).toBe("(empty)")
  })

  test("maxLen smaller than 4 hard-truncates without ellipsis", () => {
    expect(truncateQuery("hello world", 2)).toBe("he")
    expect(truncateQuery("hello world", 3)).toBe("hel")
  })

  test("maxLen zero or negative returns empty string", () => {
    expect(truncateQuery("hello", 0)).toBe("")
    expect(truncateQuery("hello", -5)).toBe("")
  })
})
