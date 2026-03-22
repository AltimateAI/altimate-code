import { describe, test, expect } from "bun:test"
import { Color } from "../../src/util/color"

describe("Color: hex validation and conversion", () => {
  describe("isValidHex", () => {
    test("accepts valid 6-digit hex with #", () => {
      expect(Color.isValidHex("#ff0000")).toBe(true)
      expect(Color.isValidHex("#00FF00")).toBe(true)
      expect(Color.isValidHex("#1a2b3c")).toBe(true)
    })

    test("rejects missing hash", () => {
      expect(Color.isValidHex("ff0000")).toBe(false)
    })

    test("rejects short hex (3-digit)", () => {
      expect(Color.isValidHex("#fff")).toBe(false)
    })

    test("rejects 8-digit hex (with alpha)", () => {
      expect(Color.isValidHex("#ff000080")).toBe(false)
    })

    test("rejects undefined and empty", () => {
      expect(Color.isValidHex(undefined)).toBe(false)
      expect(Color.isValidHex("")).toBe(false)
    })

    test("rejects non-hex chars", () => {
      expect(Color.isValidHex("#gggggg")).toBe(false)
      expect(Color.isValidHex("#zzzzzz")).toBe(false)
    })
  })

  describe("hexToRgb", () => {
    test("converts pure red", () => {
      expect(Color.hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 })
    })

    test("converts pure green", () => {
      expect(Color.hexToRgb("#00ff00")).toEqual({ r: 0, g: 255, b: 0 })
    })

    test("converts pure blue", () => {
      expect(Color.hexToRgb("#0000ff")).toEqual({ r: 0, g: 0, b: 255 })
    })

    test("converts black and white", () => {
      expect(Color.hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 })
      expect(Color.hexToRgb("#ffffff")).toEqual({ r: 255, g: 255, b: 255 })
    })

    test("handles uppercase hex", () => {
      expect(Color.hexToRgb("#1A2B3C")).toEqual({ r: 26, g: 43, b: 60 })
    })
  })

  describe("hexToAnsiBold", () => {
    test("returns ANSI escape for valid hex", () => {
      const result = Color.hexToAnsiBold("#ff0000")
      expect(result).toBe("\x1b[38;2;255;0;0m\x1b[1m")
    })

    test("returns undefined for invalid hex", () => {
      expect(Color.hexToAnsiBold("#bad")).toBeUndefined()
      expect(Color.hexToAnsiBold(undefined)).toBeUndefined()
    })
  })
})
