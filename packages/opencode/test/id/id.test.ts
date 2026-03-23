import { describe, test, expect } from "bun:test"
import { Identifier } from "../../src/id/id"

describe("Identifier: monotonic ID generation", () => {
  test("ascending IDs are strictly increasing", () => {
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      ids.push(Identifier.ascending("session"))
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true)
    }
  })

  test("descending IDs are strictly decreasing", () => {
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      ids.push(Identifier.descending("session"))
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! < ids[i - 1]!).toBe(true)
    }
  })

  test("ascending IDs have correct prefix for each type", () => {
    expect(Identifier.ascending("session")).toStartWith("ses_")
    expect(Identifier.ascending("message")).toStartWith("msg_")
    expect(Identifier.ascending("part")).toStartWith("prt_")
    expect(Identifier.ascending("permission")).toStartWith("per_")
    expect(Identifier.ascending("tool")).toStartWith("tool_")
  })

  test("same-millisecond IDs are unique via counter", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(Identifier.ascending("session"))
    }
    expect(ids.size).toBe(100)
  })

  test("given parameter returns same ID when prefix matches", () => {
    const id = Identifier.ascending("session")
    expect(Identifier.ascending("session", id)).toBe(id)
  })

  test("given parameter throws when prefix does not match", () => {
    const msgId = Identifier.ascending("message")
    expect(() => Identifier.ascending("session", msgId)).toThrow()
  })

  test("timestamp values are relatively ordered for IDs created at different times", () => {
    // timestamp() returns a truncated value (lower 48 bits of ts*4096),
    // not the actual wall-clock time. But relative ordering is preserved,
    // which is how it's used in practice (e.g., truncation.ts comparisons).
    const id1 = Identifier.create("session", false, 1000000)
    const id2 = Identifier.create("session", false, 2000000)
    expect(Identifier.timestamp(id2)).toBeGreaterThan(Identifier.timestamp(id1))
  })

  test("timestamp round-trips for small timestamps within 48-bit range", () => {
    // For small timestamps (< 2^36 ≈ 68.7B), the value fits in 48 bits
    // and round-trips exactly. Modern Date.now() values overflow this.
    const smallTs = 1000000
    const id = Identifier.create("session", false, smallTs)
    expect(Identifier.timestamp(id)).toBe(smallTs)
  })
})
