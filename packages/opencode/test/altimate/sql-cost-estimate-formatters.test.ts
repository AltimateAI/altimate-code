import { describe, test, expect } from "bun:test"
import { formatBytes, formatCost } from "../../src/altimate/tools/sql-cost-estimate"

describe("formatBytes", () => {
  test("formats zero and sub-KB without decimals", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
  })

  test("scales to KB/MB/GB/TB with two decimals", () => {
    expect(formatBytes(1024)).toBe("1.00 KB")
    expect(formatBytes(1536)).toBe("1.50 KB")
    expect(formatBytes(1024 ** 3)).toBe("1.00 GB")
    expect(formatBytes(1024 ** 4)).toBe("1.00 TB")
  })

  test("returns 'unknown' for invalid input", () => {
    expect(formatBytes(NaN)).toBe("unknown")
    expect(formatBytes(-1)).toBe("unknown")
  })
})

describe("formatCost", () => {
  test("uses 4 decimals for sub-cent values", () => {
    expect(formatCost(0.0021)).toBe("$0.0021")
    expect(formatCost(0)).toBe("$0.0000")
  })

  test("uses 2 decimals for cent-and-above values", () => {
    expect(formatCost(6.25)).toBe("$6.25")
    expect(formatCost(40)).toBe("$40.00")
  })

  test("returns 'unknown' for non-finite input", () => {
    expect(formatCost(NaN)).toBe("unknown")
    expect(formatCost(Infinity)).toBe("unknown")
  })
})
