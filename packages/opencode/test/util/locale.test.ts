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

describe("Locale.cost", () => {
  test("shows $0.00 for zero cost", () => {
    expect(Locale.cost(0)).toBe("$0.00")
  })

  test("shows 4 decimal places for sub-cent costs", () => {
    // 1K input tokens on Claude Sonnet ($3/M) = $0.003
    expect(Locale.cost(0.003)).toBe("$0.003")
    // Tiny cost that would round to $0.00 with 2 decimals
    expect(Locale.cost(0.001)).toBe("$0.001")
    expect(Locale.cost(0.0001)).toBe("$0.0001")
  })

  test("shows 4 decimal places for costs under 10 cents", () => {
    expect(Locale.cost(0.015)).toBe("$0.015")
    expect(Locale.cost(0.0567)).toBe("$0.0567")
    expect(Locale.cost(0.09)).toBe("$0.09")
  })

  test("shows standard 2 decimal places for costs >= 10 cents", () => {
    expect(Locale.cost(0.10)).toBe("$0.10")
    expect(Locale.cost(0.50)).toBe("$0.50")
    expect(Locale.cost(1.23)).toBe("$1.23")
    expect(Locale.cost(42.00)).toBe("$42.00")
  })

  test("negative amounts use standard Intl formatting", () => {
    // Negative costs should not go through the sub-cent branch
    expect(Locale.cost(-0.003)).toBe("-$0.00")
    expect(Locale.cost(-1.50)).toBe("-$1.50")
  })

  test("handles typical session costs", () => {
    // Single message: 5K input + 1K output on Claude Sonnet
    // $3 * 5000/1M + $15 * 1000/1M = $0.015 + $0.015 = $0.03
    expect(Locale.cost(0.03)).toBe("$0.03")
    // Multi-message session: accumulated ~$0.25
    expect(Locale.cost(0.25)).toBe("$0.25")
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
