import { describe, test, expect } from "bun:test"
import { Identifier } from "../../src/id/id"

describe("Identifier: prefix format and length", () => {
  test("ascending() generates ID with correct prefix", () => {
    const id = Identifier.ascending("session")
    expect(id).toMatch(/^ses_/)
  })

  test("descending() generates ID with correct prefix", () => {
    const id = Identifier.descending("message")
    expect(id).toMatch(/^msg_/)
  })

  test("ID has expected total length (prefix + _ + 26 hex/base62 chars)", () => {
    // "ses" (3) + "_" (1) + 26 = 30
    const id = Identifier.ascending("session")
    expect(id.length).toBe(30)
  })

  test("tool prefix is 4 chars (outlier)", () => {
    // "tool" (4) + "_" (1) + 26 = 31
    const id = Identifier.ascending("tool")
    expect(id).toMatch(/^tool_/)
    expect(id.length).toBe(31)
  })
})

describe("Identifier: ascending sort order", () => {
  test("IDs with increasing timestamps sort ascending (string order)", () => {
    const t = 1700000000000
    const a = Identifier.create("session", false, t)
    const b = Identifier.create("session", false, t + 1)
    expect(a < b).toBe(true)
  })

  test("multiple IDs at same timestamp are unique and ascending", () => {
    const t = 1700000001000
    const ids = Array.from({ length: 10 }, () => Identifier.create("session", false, t))
    const unique = new Set(ids)
    expect(unique.size).toBe(10)
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1] < ids[i]).toBe(true)
    }
  })
})

describe("Identifier: descending sort order", () => {
  test("IDs with increasing timestamps sort descending (string order)", () => {
    const t = 1700000002000
    const a = Identifier.create("session", true, t)
    const b = Identifier.create("session", true, t + 1)
    // Later timestamp → smaller string for descending
    expect(a > b).toBe(true)
  })
})

describe("Identifier: timestamp comparison", () => {
  test("timestamp() preserves relative ordering for ascending IDs", () => {
    const t1 = 1700000003000
    const t2 = 1700000004000
    const id1 = Identifier.create("session", false, t1)
    const id2 = Identifier.create("session", false, t2)
    // timestamp() may not recover the exact input due to 48-bit storage,
    // but it must preserve relative ordering (used for cleanup cutoffs)
    expect(Identifier.timestamp(id1)).toBeLessThan(Identifier.timestamp(id2))
  })

  test("timestamp() returns same value for IDs created at same time", () => {
    const t = 1700000005000
    const id1 = Identifier.create("session", false, t)
    const id2 = Identifier.create("session", false, t)
    // Both IDs at same timestamp should produce the same (or very close) extracted timestamp
    // The counter increment adds at most a few units that divide away
    expect(Identifier.timestamp(id1)).toBe(Identifier.timestamp(id2))
  })
})

describe("Identifier: given passthrough", () => {
  test("returns given ID as-is when prefix matches", () => {
    const given = "ses_abcdef1234567890abcdef1234"
    const result = Identifier.ascending("session", given)
    expect(result).toBe(given)
  })

  test("throws when given ID has wrong prefix", () => {
    expect(() => Identifier.ascending("session", "msg_abc")).toThrow(
      "does not start with ses",
    )
  })
})

describe("Identifier: schema validation", () => {
  test("schema accepts valid session ID", () => {
    const s = Identifier.schema("session")
    const id = Identifier.ascending("session")
    expect(s.safeParse(id).success).toBe(true)
  })

  test("schema rejects ID with wrong prefix", () => {
    const s = Identifier.schema("session")
    expect(s.safeParse("msg_abc123").success).toBe(false)
  })

  test("schema for tool prefix works (4-char prefix)", () => {
    const s = Identifier.schema("tool")
    const id = Identifier.ascending("tool")
    expect(s.safeParse(id).success).toBe(true)
    expect(s.safeParse("ses_abc").success).toBe(false)
  })
})
