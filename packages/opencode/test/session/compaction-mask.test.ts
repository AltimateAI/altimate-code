import { describe, test, expect } from "bun:test"
import { SessionCompaction } from "../../src/session/compaction"
import type { MessageV2 } from "../../src/session/message-v2"

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCompletedPart(overrides: {
  tool?: string
  input?: Record<string, any>
  output?: string
}): MessageV2.ToolPart {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "msg-1",
    type: "tool",
    callID: "call-1",
    tool: overrides.tool ?? "read",
    state: {
      status: "completed",
      input: overrides.input ?? {},
      output: overrides.output ?? "",
      title: "test",
      metadata: {},
      time: { start: 1000, end: 2000 },
    },
  } as unknown as MessageV2.ToolPart
}

function makePendingPart(overrides?: { tool?: string }): MessageV2.ToolPart {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "msg-1",
    type: "tool",
    callID: "call-1",
    tool: overrides?.tool ?? "bash",
    state: {
      status: "pending",
      input: { command: "ls -la" },
      raw: '{"command":"ls -la"}',
    },
  } as unknown as MessageV2.ToolPart
}

// ─── createObservationMask: completed tool parts ────────────────────────────

describe("SessionCompaction.createObservationMask", () => {
  test("includes tool name, args, line count, byte size, and fingerprint for completed part", () => {
    const part = makeCompletedPart({
      tool: "bash",
      input: { command: "git status" },
      output: "On branch main\nnothing to commit, working tree clean\n",
    })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("[Tool output cleared")
    expect(mask).toContain("bash(")
    expect(mask).toContain('command: "git status"')
    expect(mask).toContain("3 lines")
    expect(mask).toContain('— "On branch main"')
    // Byte size should be present
    expect(mask).toMatch(/\d+ B/)
  })

  test("omits fingerprint when output is empty", () => {
    const part = makeCompletedPart({ tool: "read", output: "" })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("read()")
    expect(mask).toContain("1 lines")
    expect(mask).toContain("0 B")
    // No fingerprint: the mask should end with the byte size then ] (no trailing — "...")
    expect(mask).not.toContain('— "')
    expect(mask).toMatch(/0 B\]$/)
  })

  test("shows empty args for pending status (falls through to {} path)", () => {
    const part = makePendingPart({ tool: "bash" })
    const mask = SessionCompaction.createObservationMask(part)

    // Pending status → output is "" (since only completed reads output)
    // Pending status → args from {} (not from input)
    expect(mask).toContain("bash()")
    expect(mask).toContain("1 lines")
    expect(mask).toContain("0 B")
  })

  test("handles completed part with multi-line output", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    const output = lines.join("\n")
    const part = makeCompletedPart({ tool: "grep", output })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("100 lines")
    expect(mask).toContain('— "line 1"')
  })

  test("truncates long args with ellipsis", () => {
    const longValue = "x".repeat(200)
    const part = makeCompletedPart({
      tool: "write",
      input: { file_path: "/some/file.ts", content: longValue },
      output: "ok",
    })
    const mask = SessionCompaction.createObservationMask(part)

    // Args should be truncated (maxLen=80) and end with "…"
    expect(mask).toContain("write(")
    expect(mask).toContain("…")
    // The full 200-char value should NOT appear
    expect(mask).not.toContain(longValue)
  })

  test("handles unserializable input gracefully", () => {
    // Create a circular reference that JSON.stringify can't handle
    const circular: Record<string, any> = { key: "value" }
    circular.self = circular

    const part = makeCompletedPart({
      tool: "bash",
      input: circular,
      output: "result",
    })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("bash([unserializable])")
  })

  test("formats byte size in KB for larger outputs", () => {
    // 2048 bytes → should display as "2.0 KB"
    const output = "a".repeat(2048)
    const part = makeCompletedPart({ tool: "read", output })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("2.0 KB")
  })

  test("formats byte size in MB for very large outputs", () => {
    // 1.5 MB output
    const output = "b".repeat(1024 * 1024 + 512 * 1024)
    const part = makeCompletedPart({ tool: "read", output })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("1.5 MB")
  })

  test("correctly counts bytes for multi-byte UTF-8 characters", () => {
    // Each CJK character is 3 bytes in UTF-8
    const output = "你好世界" // 4 chars × 3 bytes = 12 bytes
    const part = makeCompletedPart({ tool: "read", output })
    const mask = SessionCompaction.createObservationMask(part)

    expect(mask).toContain("12 B")
    expect(mask).toContain('— "你好世界"')
  })

  test("fingerprint is capped at 80 characters", () => {
    const longFirstLine = "z".repeat(200)
    const part = makeCompletedPart({ tool: "bash", output: longFirstLine })
    const mask = SessionCompaction.createObservationMask(part)

    // The fingerprint should contain the first 80 chars, not all 200
    const fingerprint80 = "z".repeat(80)
    expect(mask).toContain(`— "${fingerprint80}"`)
    expect(mask).not.toContain("z".repeat(81))
  })
})

// ─── Mask redaction before replay ───────────────────────────────────────────

// The mask REPLACES cleared tool output and is replayed on every subsequent
// provider request, so anything it retains outlives the clear and survives a
// provider switch. Both fields it copies — the serialized arguments and the
// first output line — previously bypassed the ledger's redaction entirely.
describe("SessionCompaction.createObservationMask redaction", () => {
  test("redacts secrets carried in the tool arguments", () => {
    const cases: Array<[Record<string, any>, string]> = [
      [{ command: "curl -u alice:dummy-password https://x.com" }, "dummy-password"],
      [{ command: "export OPENAI_API_KEY=dummy-openai" }, "dummy-openai"],
      [{ command: "tool --user 1234:dummy-password" }, "dummy-password"],
      [{ command: "fetch --token dummy-token-value" }, "dummy-token-value"],
    ]
    for (const [input, secret] of cases) {
      const mask = SessionCompaction.createObservationMask(makeCompletedPart({ tool: "bash", input, output: "ok" }))
      expect(mask).not.toContain(secret)
    }
  })

  test("redacts a secret held under a sensitive argument NAME", () => {
    // Value-level pattern matching cannot see this: an opaque token matches no
    // shape on its own, so the KEY is what marks it as a credential.
    const mask = SessionCompaction.createObservationMask(
      makeCompletedPart({ tool: "fetch", input: { api_key: "sk-abc123opaque", url: "https://x.com" }, output: "ok" }),
    )
    expect(mask).not.toContain("sk-abc123opaque")
    // Nested one level down, too.
    const nested = SessionCompaction.createObservationMask(
      makeCompletedPart({ tool: "fetch", input: { headers: { authorization: "Bearer dummy-jwt" } }, output: "ok" }),
    )
    expect(nested).not.toContain("dummy-jwt")
  })

  test("redacts every alias of a shared nested argument object", () => {
    const shared = { authorization: "Bearer shared-secret-value", label: "ordinary" }
    const mask = SessionCompaction.createObservationMask(
      makeCompletedPart({ tool: "fetch", input: { first: shared, second: shared }, output: "ok" }),
    )
    expect(mask).not.toContain("shared-secret-value")
    expect(mask).toContain("ordinary")
  })

  test("redacts secrets carried in the first output line", () => {
    const cases = [
      ["AWS_SECRET_ACCESS_KEY=dummy-assignment\nrest", "dummy-assignment"],
      ["https://example.com/d?X-Amz-Signature=dummy-signature", "dummy-signature"],
      ["Authorization: Bearer dummy-bearer", "dummy-bearer"],
    ]
    for (const [output, secret] of cases) {
      const mask = SessionCompaction.createObservationMask(
        makeCompletedPart({ tool: "bash", input: { command: "echo hi" }, output }),
      )
      expect(mask).not.toContain(secret)
    }
  })

  // Redaction must not cost the mask its purpose. A first attempt redacted the
  // JSON and the joined `k: v` text, which collapsed every argument to "?" —
  // the mask stayed safe and became useless.
  test("keeps ordinary arguments and fingerprints legible", () => {
    const mask = SessionCompaction.createObservationMask(
      makeCompletedPart({ tool: "bash", input: { command: "git status" }, output: "On branch main\nclean" }),
    )
    expect(mask).toContain('command: "git status"')
    expect(mask).toContain("On branch main")
  })

  // Guards a hang this redaction pass introduced and the suite caught: walking
  // an arbitrary tool input to redact its string leaves followed the cycle.
  test("a circular argument still degrades to [unserializable] rather than hanging", () => {
    const circular: Record<string, any> = { key: "value" }
    circular.self = circular
    const mask = SessionCompaction.createObservationMask(
      makeCompletedPart({ tool: "bash", input: circular, output: "ok" }),
    )
    expect(mask).toContain("[unserializable]")
  })

  // Guards the second hang: redactLedgerDetail cost grows super-linearly
  // (1 KB 2ms, 10 KB 77ms, 100 KB 6.2s) and tool output can be megabytes, so
  // redaction runs over a bounded window rather than the whole line.
  test("a multi-megabyte single-line output masks promptly", () => {
    const output = "b".repeat(1024 * 1024 + 512 * 1024)
    const started = Date.now()
    const mask = SessionCompaction.createObservationMask(
      makeCompletedPart({ tool: "bash", input: { command: "cat big" }, output }),
    )
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(mask).toContain("[Tool output cleared")
  }, 30_000)
})
