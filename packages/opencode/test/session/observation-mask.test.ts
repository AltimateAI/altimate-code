import { describe, test, expect } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"
import type { MessageV2 } from "../../src/session/message-v2"

function makeToolPart(overrides: {
  tool?: string
  input?: Record<string, any>
  output?: string
  status?: "completed" | "running" | "error" | "pending"
}): MessageV2.ToolPart {
  const status = overrides.status ?? "completed"
  const base = {
    id: "part_1" as any,
    sessionID: "sess_1" as any,
    messageID: "msg_1" as any,
    type: "tool" as const,
    callID: "call_1",
    tool: overrides.tool ?? "terminal",
  }

  if (status === "completed") {
    return {
      ...base,
      state: {
        status: "completed",
        input: overrides.input ?? {},
        output: overrides.output ?? "",
        title: "test",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    } as MessageV2.ToolPart
  }

  if (status === "running") {
    return {
      ...base,
      state: {
        status: "running",
        input: overrides.input ?? {},
        time: { start: 1 },
      },
    } as MessageV2.ToolPart
  }

  if (status === "error") {
    return {
      ...base,
      state: {
        status: "error",
        input: overrides.input ?? {},
        error: "something failed",
        time: { start: 1, end: 2 },
      },
    } as MessageV2.ToolPart
  }

  return {
    ...base,
    state: { status: "pending" },
  } as MessageV2.ToolPart
}

describe("SessionCompaction.createObservationMask", () => {
  test("produces correct mask for a completed tool with normal output", () => {
    const part = makeToolPart({
      tool: "read",
      input: { file_path: "/src/index.ts" },
      output: "line1\nline2\nline3",
    })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("[Tool output cleared")
    expect(mask).toContain("read(")
    expect(mask).toContain("file_path:")
    expect(mask).toContain("returned 3 lines")
    // "line1\nline2\nline3" = 17 bytes ASCII
    expect(mask).toContain("17 B")
    // First line fingerprint
    expect(mask).toContain('— "line1"')
  })

  test("handles empty output gracefully", () => {
    const part = makeToolPart({
      tool: "terminal",
      input: { command: "echo hello" },
      output: "",
    })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("returned 1 lines")
    expect(mask).toContain("0 B")
    // No fingerprint for empty output
    expect(mask).not.toContain('— "')
  })

  test("counts lines and bytes correctly for multi-line output", () => {
    // Generate enough lines to exceed 1 KB
    const lines = Array.from({ length: 200 }, (_, i) => `output line number ${i}`)
    const output = lines.join("\n")
    const part = makeToolPart({ tool: "grep", output })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("returned 200 lines")
    const expectedBytes = Buffer.byteLength(output, "utf8")
    expect(expectedBytes).toBeGreaterThan(1024)
    expect(mask).toMatch(/\d+\.\d+ KB/)
    expect(mask).toContain('— "output line number 0"')
  })

  test("formats bytes as KB and MB for larger outputs", () => {
    // ~1 MB output
    const bigOutput = "x".repeat(1024 * 1024 + 512)
    const part = makeToolPart({ tool: "cat", output: bigOutput })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toMatch(/1\.0 MB/)
  })

  test("truncates long args without breaking surrogate pairs", () => {
    // Create input with a value containing emoji (surrogate pairs in JS)
    // U+1F600 = 😀 is represented as \uD83D\uDE00 in UTF-16
    const emoji = "😀"
    // Build a value string where the emoji sits right near the truncation boundary
    const padding = "a".repeat(70)
    const part = makeToolPart({
      tool: "write",
      input: { content: padding + emoji + "after" },
    })
    const mask = SessionCompaction.createObservationMask(part)

    // The mask should not contain a lone high surrogate
    // Verify the args portion is well-formed by checking the whole mask is valid
    expect(mask).toBeDefined()
    // Ensure no lone surrogates by round-tripping through TextEncoder
    const encoded = new TextEncoder().encode(mask)
    const decoded = new TextDecoder().decode(encoded)
    expect(decoded).toBe(mask)
  })

  test("uses empty input for pending tool parts", () => {
    const part = makeToolPart({ tool: "terminal", status: "pending" })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("terminal()")
    expect(mask).toContain("returned 1 lines")
    expect(mask).toContain("0 B")
  })

  test("uses input from running tool parts", () => {
    const part = makeToolPart({
      tool: "edit",
      input: { file: "main.ts" },
      status: "running",
    })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("edit(file:")
    // Running parts have no output
    expect(mask).toContain("0 B")
  })

  test("uses input from error tool parts", () => {
    const part = makeToolPart({
      tool: "terminal",
      input: { command: "rm -rf /" },
      status: "error",
    })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("terminal(command:")
    expect(mask).toContain("0 B")
  })
})
