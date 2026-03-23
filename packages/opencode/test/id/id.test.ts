import { describe, test, expect } from "bun:test"
import { Identifier } from "../../src/id/id"

describe("Identifier", () => {
  describe("ascending", () => {
    test("generates ID with correct prefix", () => {
      const id = Identifier.ascending("session")
      expect(id).toStartWith("ses_")
      expect(id.length).toBeGreaterThan(10)
    })

    test("generates monotonically increasing IDs", () => {
      const ids = Array.from({ length: 100 }, () => Identifier.ascending("message"))
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i] > ids[i - 1]).toBe(true)
      }
    })

    test("returns given ID when prefix matches", () => {
      const given = "ses_abc123"
      const id = Identifier.ascending("session", given)
      expect(id).toBe(given)
    })

    test("accepts any string that starts with the prefix — prefix check is permissive", () => {
      // "session_xyz" starts with "ses", so generateID accepts it
      const given = "ses_sion_xyz"
      const id = Identifier.ascending("session", given)
      expect(id).toBe(given)
    })

    test("throws on mismatched prefix", () => {
      expect(() => Identifier.ascending("session", "msg_abc123")).toThrow(
        "ID msg_abc123 does not start with ses",
      )
    })
  })

  describe("descending", () => {
    test("generates ID with correct prefix", () => {
      const id = Identifier.descending("session")
      expect(id).toStartWith("ses_")
    })

    test("generates monotonically decreasing IDs", () => {
      const ids = Array.from({ length: 100 }, () => Identifier.descending("session"))
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i] < ids[i - 1]).toBe(true)
      }
    })
  })

  describe("timestamp", () => {
    test("relative comparison works between IDs created close together", () => {
      // timestamp() is used in tool/truncation.ts for relative age comparisons.
      // It only stores 48 bits, so absolute values overflow for modern timestamps,
      // but relative comparisons between IDs in the same era are consistent.
      const earlier = Identifier.create("tool", false, Date.now() - 60_000)
      const later = Identifier.create("tool", false, Date.now())
      expect(Identifier.timestamp(later)).toBeGreaterThan(Identifier.timestamp(earlier))
    })

    test("extracts consistent value from same ID", () => {
      const id = Identifier.ascending("session")
      const ts1 = Identifier.timestamp(id)
      const ts2 = Identifier.timestamp(id)
      expect(ts1).toBe(ts2)
    })
  })

  describe("all prefixes", () => {
    const prefixes = [
      ["session", "ses_"],
      ["message", "msg_"],
      ["permission", "per_"],
      ["question", "que_"],
      ["user", "usr_"],
      ["part", "prt_"],
      ["pty", "pty_"],
      ["tool", "tool_"],
      ["workspace", "wrk_"],
    ] as const

    for (const [key, prefix] of prefixes) {
      test(`${key} generates IDs starting with ${prefix}`, () => {
        const id = Identifier.ascending(key as any)
        expect(id).toStartWith(prefix)
      })
    }
  })
})
