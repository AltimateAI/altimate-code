import { describe, test, expect } from "bun:test"
import { Locale } from "../../src/util/locale"

describe("Locale.number", () => {
  test("formats millions", () => {
    expect(Locale.number(1500000)).toBe("1.5M")
    expect(Locale.number(1000000)).toBe("1.0M")
  })

  test("formats thousands", () => {
    expect(Locale.number(1500)).toBe("1.5K")
    expect(Locale.number(1000)).toBe("1.0K")
  })

  test("boundary: 999999 renders as K not M", () => {
    expect(Locale.number(999999)).toBe("1000.0K")
  })

  test("returns raw string for small numbers", () => {
    expect(Locale.number(999)).toBe("999")
    expect(Locale.number(0)).toBe("0")
  })
})

describe("Locale.duration", () => {
  test("milliseconds", () => {
    expect(Locale.duration(500)).toBe("500ms")
    expect(Locale.duration(0)).toBe("0ms")
  })

  test("seconds", () => {
    expect(Locale.duration(1500)).toBe("1.5s")
    expect(Locale.duration(2500)).toBe("2.5s")
  })

  test("minutes and seconds", () => {
    expect(Locale.duration(90000)).toBe("1m 30s")
    expect(Locale.duration(3599999)).toBe("59m 59s")
  })

  test("hours and minutes", () => {
    expect(Locale.duration(3600000)).toBe("1h 0m")
    expect(Locale.duration(5400000)).toBe("1h 30m")
  })

  // Fixed in this PR: days and hours were swapped for >=24h durations.
  // 90000000ms = 25h = 1d 1h
  // See: https://github.com/AltimateAI/altimate-code/issues/368
  test("days and hours for >=24h are calculated correctly", () => {
    expect(Locale.duration(90000000)).toBe("1d 1h")
  })
})

describe("Locale.clockTime", () => {
  test("renders HH:MM:SS in 24-hour form", () => {
    // 2024-01-15T03:04:05 in the host's local time, since the helper formats local time.
    const d = new Date(2024, 0, 15, 3, 4, 5).getTime()
    const out = Locale.clockTime(d)
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(out).toBe("03:04:05")
  })

  test("zero-pads single digit components", () => {
    const d = new Date(2024, 0, 15, 9, 0, 7).getTime()
    expect(Locale.clockTime(d)).toBe("09:00:07")
  })
})

describe("Locale.truncateMiddle", () => {
  test("returns original if short enough", () => {
    expect(Locale.truncateMiddle("hello", 35)).toBe("hello")
  })

  test("truncates long strings with ellipsis in middle", () => {
    const long = "abcdefghijklmnopqrstuvwxyz1234567890abcdef"
    const result = Locale.truncateMiddle(long, 20)
    expect(result.length).toBe(20)
    expect(result).toContain("\u2026")
    expect(result.startsWith("abcdefghij")).toBe(true)
    expect(result.endsWith("bcdef")).toBe(true)
  })
})

describe("Locale.pluralize", () => {
  test("uses singular for count=1", () => {
    expect(Locale.pluralize(1, "{} item", "{} items")).toBe("1 item")
  })

  test("uses plural for count!=1", () => {
    expect(Locale.pluralize(0, "{} item", "{} items")).toBe("0 items")
    expect(Locale.pluralize(5, "{} item", "{} items")).toBe("5 items")
  })
})
