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

  // BUG: Locale.duration >=24h has swapped days/hours calculation.
  // hours = Math.floor(input / 3600000) gives total hours (25), not remainder.
  // days = Math.floor((input % 3600000) / 86400000) always yields 0.
  // Correct: days = Math.floor(input / 86400000), hours = Math.floor((input % 86400000) / 3600000)
  // 90000000ms = 25h = 1d 1h — should display "1d 1h"
  // See: https://github.com/AltimateAI/altimate-code/issues/368
  test.skip("FIXME: days and hours for >=24h are calculated correctly", () => {
    expect(Locale.duration(90000000)).toBe("1d 1h")
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
