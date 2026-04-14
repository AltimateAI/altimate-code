import { describe, expect, test } from "bun:test"

/**
 * Tests for the --page convenience option added to `trace list`.
 *
 * The page-to-offset conversion lives inline in the CLI handler, so we test
 * the formula directly here rather than spawning a subprocess.
 */

// --- page-to-offset conversion (mirrors the handler logic) ---

function pageToOffset(page: number | undefined, offset: number, limit: number): number {
  if (page != null) {
    return (Math.max(1, Math.trunc(page)) - 1) * limit
  }
  return offset
}

describe("trace list --page to offset conversion", () => {
  test("page 1 maps to offset 0", () => {
    expect(pageToOffset(1, 0, 20)).toBe(0)
  })

  test("page 2 with default limit maps to offset 20", () => {
    expect(pageToOffset(2, 0, 20)).toBe(20)
  })

  test("page 3 with limit 10 maps to offset 20", () => {
    expect(pageToOffset(3, 0, 10)).toBe(20)
  })

  test("page 5 with limit 5 maps to offset 20", () => {
    expect(pageToOffset(5, 0, 5)).toBe(20)
  })

  test("page takes precedence over explicit offset", () => {
    // --page 2 --offset 99 → page wins
    expect(pageToOffset(2, 99, 20)).toBe(20)
  })

  test("undefined page falls back to provided offset", () => {
    expect(pageToOffset(undefined, 40, 20)).toBe(40)
  })

  test("page 0 is clamped to page 1 (offset 0)", () => {
    expect(pageToOffset(0, 0, 20)).toBe(0)
  })

  test("negative page is clamped to page 1 (offset 0)", () => {
    expect(pageToOffset(-5, 0, 20)).toBe(0)
  })

  test("fractional page is truncated", () => {
    // page 2.7 → trunc to 2 → offset 20
    expect(pageToOffset(2.7, 0, 20)).toBe(20)
  })
})

// --- pagination footer formatting (mirrors listTraces footer) ---

function formatFooter(offset: number, limit: number, total: number, shown: number) {
  const rangeStart = offset + 1
  const rangeEnd = offset + shown
  const currentPage = Math.floor(offset / limit) + 1
  const totalPages = Math.ceil(total / limit)
  const summary = `Showing ${rangeStart}-${rangeEnd} of ${total} trace(s) (page ${currentPage}/${totalPages})`
  const nextHint = rangeEnd < total
    ? `Next page: altimate-code trace list --page ${currentPage + 1}`
    : null
  return { summary, nextHint }
}

describe("trace list pagination footer", () => {
  test("first page of multiple shows page 1/N and next hint", () => {
    const { summary, nextHint } = formatFooter(0, 20, 50, 20)
    expect(summary).toBe("Showing 1-20 of 50 trace(s) (page 1/3)")
    expect(nextHint).toBe("Next page: altimate-code trace list --page 2")
  })

  test("middle page shows correct range and next hint", () => {
    const { summary, nextHint } = formatFooter(20, 20, 50, 20)
    expect(summary).toBe("Showing 21-40 of 50 trace(s) (page 2/3)")
    expect(nextHint).toBe("Next page: altimate-code trace list --page 3")
  })

  test("last page has no next hint", () => {
    const { summary, nextHint } = formatFooter(40, 20, 50, 10)
    expect(summary).toBe("Showing 41-50 of 50 trace(s) (page 3/3)")
    expect(nextHint).toBeNull()
  })

  test("single page has no next hint", () => {
    const { summary, nextHint } = formatFooter(0, 20, 5, 5)
    expect(summary).toBe("Showing 1-5 of 5 trace(s) (page 1/1)")
    expect(nextHint).toBeNull()
  })

  test("custom limit changes page calculation", () => {
    const { summary, nextHint } = formatFooter(10, 10, 35, 10)
    expect(summary).toBe("Showing 11-20 of 35 trace(s) (page 2/4)")
    expect(nextHint).toBe("Next page: altimate-code trace list --page 3")
  })
})
