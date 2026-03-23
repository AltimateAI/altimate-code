import { describe, test, expect } from "bun:test"
import { Identifier } from "../../src/id/id"

describe("Identifier: monotonic ID generation and timestamp extraction", () => {
  test("ascending IDs have correct prefix", () => {
    const id = Identifier.ascending("session")
    expect(id.startsWith("ses_")).toBe(true)

    const toolId = Identifier.ascending("tool")
    expect(toolId.startsWith("tool_")).toBe(true)

    const msgId = Identifier.ascending("message")
    expect(msgId.startsWith("msg_")).toBe(true)
  })

  test("descending IDs have correct prefix", () => {
    const id = Identifier.descending("session")
    expect(id.startsWith("ses_")).toBe(true)

    const id2 = Identifier.descending("message")
    expect(id2.startsWith("msg_")).toBe(true)
  })

  test("ascending IDs sort chronologically", () => {
    const id1 = Identifier.create("tool", false, Date.now() - 10000)
    const id2 = Identifier.create("tool", false, Date.now())
    expect(id1 < id2).toBe(true)
  })

  test("descending IDs sort reverse-chronologically", () => {
    const id1 = Identifier.create("tool", true, Date.now() - 10000)
    const id2 = Identifier.create("tool", true, Date.now())
    expect(id1 > id2).toBe(true)
  })

  test("timestamp() preserves ordering for ascending IDs", () => {
    // timestamp() extracts a value from the lower 48 bits of the encoded ID.
    // It doesn't round-trip to the exact millisecond, but it preserves ordering,
    // which is what Truncate.cleanup() relies on for age comparisons.
    const t1 = Date.now() - 60000
    const t2 = Date.now()
    const id1 = Identifier.create("session", false, t1)
    const id2 = Identifier.create("session", false, t2)
    expect(Identifier.timestamp(id1)).toBeLessThan(Identifier.timestamp(id2))
  })

  test("given ID is returned if prefix matches", () => {
    const existing = "ses_abc123"
    const result = Identifier.ascending("session", existing)
    expect(result).toBe(existing)
  })

  test("given ID throws if prefix mismatches", () => {
    expect(() => Identifier.ascending("session", "msg_abc123")).toThrow(
      "does not start with ses",
    )
  })

  test("monotonic counter differentiates same-millisecond IDs", () => {
    const ts = Date.now()
    const id1 = Identifier.create("tool", false, ts)
    const id2 = Identifier.create("tool", false, ts)
    expect(id1).not.toBe(id2)
    // Both ascending, counter increments, so id1 < id2
    expect(id1 < id2).toBe(true)
  })
})
