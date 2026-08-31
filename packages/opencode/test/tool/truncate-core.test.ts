import { describe, test, expect } from "bun:test"
import { TruncateCore } from "@/tool/truncate-core"

// Pure algorithm tests for the module shared by tool/truncate.ts (the Effect
// Service wired into every Tool.define() output, including bash) and
// tool/truncation.ts (the plain-async twin). Exercising the shared function
// directly is what guarantees a change here cannot silently apply to only
// one of the two call paths.

function assembleDefault(text: string, opts: Partial<TruncateCore.ResolvedOptions> = {}) {
  const resolved: TruncateCore.ResolvedOptions = {
    maxLines: TruncateCore.MAX_LINES,
    maxBytes: TruncateCore.MAX_BYTES,
    direction: TruncateCore.DEFAULT_DIRECTION,
    headRatio: TruncateCore.DEFAULT_HEAD_RATIO,
    ...opts,
  }
  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")
  if (TruncateCore.fits(lines, totalBytes, resolved.maxLines, resolved.maxBytes)) {
    return { truncated: false as const, content: text }
  }
  const p = TruncateCore.preview(lines, totalBytes, resolved)
  return { truncated: true as const, content: TruncateCore.assemble(p, "[hint]", resolved.direction), preview: p }
}

describe("TruncateCore", () => {
  test("defaults to middle direction", () => {
    expect(TruncateCore.DEFAULT_DIRECTION).toBe("middle")
  })

  test("defaults to a 1/3 head : 2/3 tail split", () => {
    expect(TruncateCore.DEFAULT_HEAD_RATIO).toBeCloseTo(1 / 3)
  })

  test("fits() reports false only when a limit is exceeded", () => {
    expect(TruncateCore.fits(["a", "b"], 2, 10, 10)).toBe(true)
    expect(TruncateCore.fits(["a", "b", "c"], 2, 2, 10)).toBe(false)
    expect(TruncateCore.fits(["a", "b"], 100, 10, 10)).toBe(false)
  })

  test("head direction keeps only the leading lines", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    const result = assembleDefault(text, { maxLines: 3, direction: "head" })
    expect(result.truncated).toBe(true)
    expect(result.content).toContain("line0")
    expect(result.content).toContain("line2")
    expect(result.content).not.toContain("line9")
  })

  test("tail direction keeps only the trailing lines", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    const result = assembleDefault(text, { maxLines: 3, direction: "tail" })
    expect(result.truncated).toBe(true)
    expect(result.content).toContain("line9")
    expect(result.content).toContain("line7")
    expect(result.content).not.toContain("line0")
  })

  test("middle direction keeps head and tail, never the same line twice", () => {
    const text = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n")
    // maxLines 6 -> 1/3 head = 2 lines, 2/3 tail = 4 lines.
    const result = assembleDefault(text, { maxLines: 6, direction: "middle" })
    expect(result.truncated).toBe(true)
    expect(result.content).toContain("line0")
    expect(result.content).toContain("line1")
    expect(result.content).toContain("line8")
    expect(result.content).toContain("line9")
    expect(result.content).toContain("line10")
    expect(result.content).toContain("line11")
    expect(result.content).not.toContain("line5")
  })

  test("middle direction with maxLines=1 keeps exactly one line, not one from each half", () => {
    const text = Array.from({ length: 5 }, (_, i) => `line${i}`).join("\n")
    const result = assembleDefault(text, { maxLines: 1, direction: "middle" })
    expect(result.truncated).toBe(true)
    expect(result.preview!.head.split("\n").filter(Boolean).length + result.preview!.tail.split("\n").filter(Boolean).length).toBe(
      1,
    )
  })

  test("middle direction respects a custom head ratio", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n")
    // headRatio 0.5 with maxLines 10 -> 5 head lines, 5 tail lines.
    const result = assembleDefault(text, { maxLines: 10, direction: "middle", headRatio: 0.5 })
    expect(result.truncated).toBe(true)
    for (let i = 0; i < 5; i++) expect(result.content).toContain(`line${i}`)
    for (let i = 25; i < 30; i++) expect(result.content).toContain(`line${i}`)
    expect(result.content).not.toContain("line15")
  })

  test(">50KB log: a trailing success line survives default middle truncation", () => {
    const noise = Array.from({ length: 3000 }, (_, i) => `build step ${i}: compiling module_${i}.ts`)
    const successLine = "Done. PASS=42 FAIL=0"
    const text = [...noise, successLine].join("\n")
    expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(50 * 1024)

    const result = assembleDefault(text)
    expect(result.truncated).toBe(true)
    expect(result.content).toContain(successLine)
  })

  test(">50KB log: the first error line survives default middle truncation", () => {
    const firstError = "ERROR: schema.sql:1: syntax error near CREAT"
    const noise = Array.from({ length: 3000 }, (_, i) => `build step ${i}: compiling module_${i}.ts`)
    const text = [firstError, ...noise].join("\n")
    expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(50 * 1024)

    const result = assembleDefault(text)
    expect(result.truncated).toBe(true)
    expect(result.content).toContain(firstError)
  })

  test(">50KB log with both a leading error and a trailing success line: both survive", () => {
    const firstError = "ERROR: schema.sql:1: syntax error near CREAT"
    const successLine = "Done. PASS=42 FAIL=0"
    const noise = Array.from({ length: 3000 }, (_, i) => `build step ${i}: compiling module_${i}.ts`)
    const text = [firstError, ...noise, successLine].join("\n")
    expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(50 * 1024)

    const result = assembleDefault(text)
    expect(result.truncated).toBe(true)
    expect(result.content).toContain(firstError)
    expect(result.content).toContain(successLine)
    // and the elided middle noise is gone
    expect(result.content).not.toContain("build step 1500")
  })

  test("reports unit as bytes when the byte budget (not the line budget) is the binding constraint", () => {
    const text = "a".repeat(2000)
    const result = assembleDefault(text, { maxLines: 1_000_000, maxBytes: 100, direction: "middle" })
    expect(result.truncated).toBe(true)
    expect(result.content).toContain("bytes truncated")
  })

  test("middle direction: a boundary line too big for either half's split budget still survives if it fits the overall maxBytes", () => {
    // Two 80-byte lines (161 bytes total, over the 100-byte cap, so this doesn't
    // fit and truncation runs). maxBytes=100 with the default 1/3 head ratio
    // splits into a ~33-byte head budget and a ~67-byte tail budget — neither
    // half can hold an 80-byte line on its own, even though the FIRST line alone
    // fits the undivided 100-byte total.
    const firstLine = "x".repeat(80)
    const secondLine = "y".repeat(80)
    const text = `${firstLine}\n${secondLine}`
    const result = assembleDefault(text, { maxLines: 10, maxBytes: 100, direction: "middle" })
    expect(result.truncated).toBe(true)
    expect(result.content).toContain(firstLine)
  })

  test("middle direction: an out-of-range headRatio is clamped instead of blowing the byte budget", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n")
    for (const badRatio of [5, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = assembleDefault(text, { maxLines: 6, maxBytes: 40, direction: "middle", headRatio: badRatio })
      expect(result.truncated).toBe(true)
      // The two halves together must never exceed the byte budget they were split from.
      const headBytes = Buffer.byteLength(result.preview!.head, "utf-8")
      const tailBytes = Buffer.byteLength(result.preview!.tail, "utf-8")
      expect(headBytes + tailBytes).toBeLessThanOrEqual(40)
    }
  })

  test("assemble() places the elision marker and hint between head and tail for middle direction", () => {
    const p: TruncateCore.Preview = { head: "HEAD", tail: "TAIL", removed: 5, unit: "lines" }
    const content = TruncateCore.assemble(p, "HINT", "middle")
    const headIdx = content.indexOf("HEAD")
    const markerIdx = content.indexOf("...5 lines truncated...")
    const hintIdx = content.indexOf("HINT")
    const tailIdx = content.lastIndexOf("TAIL")
    expect(headIdx).toBeGreaterThanOrEqual(0)
    expect(markerIdx).toBeGreaterThan(headIdx)
    expect(hintIdx).toBeGreaterThan(markerIdx)
    expect(tailIdx).toBeGreaterThan(hintIdx)
  })
})
