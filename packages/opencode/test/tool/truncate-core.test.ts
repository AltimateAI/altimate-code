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

describe("TruncateCore maxLines=1 edge", () => {
  test("middle direction with a 1-line budget keeps exactly one line (the tail), never two", () => {
    const text = ["first error line", "noise", "noise", "final verdict line"].join("\n")
    const lines = text.split("\n")
    const totalBytes = Buffer.byteLength(text, "utf-8")
    const p = TruncateCore.preview(lines, totalBytes, {
      maxLines: 1,
      maxBytes: TruncateCore.MAX_BYTES,
      direction: "middle",
      headRatio: TruncateCore.DEFAULT_HEAD_RATIO,
    })
    const kept = [p.head, p.tail].filter((part) => part.length > 0).join("\n").split("\n")
    expect(kept).toHaveLength(1)
    // Tail-weighted design: the surviving line is the last one.
    expect(p.tail).toBe("final verdict line")
    expect(p.head).toBe("")
    expect(p.removed).toBe(3)
  })
})

// altimate_change start — PR #1171 review: oversized boundary lines and
// degenerate byte budgets. Before these fixes a single line longer than a
// half's byte share selected nothing, so a middle preview of a one-line dump
// reached the model as a bare truncation marker with zero content; and the two
// middle byte budgets were each floored at 1, so they could sum above maxBytes.
describe("TruncateCore oversized boundary lines", () => {
  const opts = (over: Partial<TruncateCore.ResolvedOptions> = {}): TruncateCore.ResolvedOptions => ({
    maxLines: TruncateCore.MAX_LINES,
    maxBytes: TruncateCore.MAX_BYTES,
    direction: TruncateCore.DEFAULT_DIRECTION,
    headRatio: TruncateCore.DEFAULT_HEAD_RATIO,
    ...over,
  })

  function run(text: string, over: Partial<TruncateCore.ResolvedOptions> = {}) {
    const resolved = opts(over)
    const lines = text.split("\n")
    return TruncateCore.preview(lines, Buffer.byteLength(text, "utf-8"), resolved)
  }

  test("a single line longer than the whole budget still yields content in middle mode", () => {
    const text = "x".repeat(10_000)
    const p = run(text, { maxBytes: 300, direction: "middle" })
    expect(p.head.length + p.tail.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(p.head + p.tail, "utf-8")).toBeLessThanOrEqual(300)
  })

  test("head and tail of a single oversized line do not overlap in bytes", () => {
    const text = "H".repeat(5_000) + "T".repeat(5_000)
    const p = run(text, { maxBytes: 300, direction: "middle" })
    expect(Buffer.byteLength(p.head + p.tail, "utf-8")).toBeLessThanOrEqual(300)
    // head comes from the front of the line, tail from the back
    expect(p.head.startsWith("H")).toBe(true)
    expect(p.tail.endsWith("T")).toBe(true)
  })

  test("an oversized first line no longer erases the head half entirely", () => {
    const text = ["A".repeat(5_000), "middle noise", "final verdict"].join("\n")
    const p = run(text, { maxBytes: 400, direction: "middle" })
    expect(p.head.length).toBeGreaterThan(0)
    expect(p.head.startsWith("A")).toBe(true)
    expect(p.tail).toContain("final verdict")
  })

  test("tail-only direction keeps a suffix when the last line exceeds the budget", () => {
    const text = ["short", "Z".repeat(9_000)].join("\n")
    const p = run(text, { maxBytes: 200, direction: "tail" })
    expect(p.tail.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(p.tail, "utf-8")).toBeLessThanOrEqual(200)
  })

  test("head-only direction keeps a prefix when the first line exceeds the budget", () => {
    const text = ["Q".repeat(9_000), "trailing"].join("\n")
    const p = run(text, { maxBytes: 200, direction: "head" })
    expect(p.head.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(p.head, "utf-8")).toBeLessThanOrEqual(200)
  })

  test("maxLines=1 with an oversized final line still returns content", () => {
    const text = ["a", "b", "W".repeat(4_000)].join("\n")
    const p = run(text, { maxLines: 1, maxBytes: 150, direction: "middle" })
    expect(p.tail.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(p.tail, "utf-8")).toBeLessThanOrEqual(150)
  })

  test("multi-byte characters are never split mid-codepoint", () => {
    // 3-byte characters; a naive byte cut at 200 would land mid-codepoint.
    const text = "日".repeat(2_000)
    const p = run(text, { maxBytes: 200, direction: "middle" })
    const combined = p.head + p.tail
    expect(combined.length).toBeGreaterThan(0)
    expect(combined).not.toContain("�")
    expect(Buffer.byteLength(combined, "utf-8")).toBeLessThanOrEqual(200)
  })

  test("middle byte budgets never sum above maxBytes for degenerate limits", () => {
    for (const maxBytes of [1, 2, 3, 4, 5]) {
      const text = ["aaaa", "bbbb", "cccc"].join("\n")
      const p = run(text, { maxBytes, maxLines: 10, direction: "middle" })
      expect(Buffer.byteLength(p.head + p.tail, "utf-8")).toBeLessThanOrEqual(maxBytes)
    }
  })

  test("a degraded middle preview assembles without a leading blank line", () => {
    const p: TruncateCore.Preview = { head: "", tail: "final", removed: 3, unit: "lines" }
    const out = TruncateCore.assemble(p, "[hint]", "middle")
    expect(out.startsWith("\n")).toBe(false)
    expect(out.startsWith("...3 lines truncated...")).toBe(true)
  })
})
// altimate_change end
