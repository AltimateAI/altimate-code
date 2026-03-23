import { describe, test, expect } from "bun:test"
import { Color } from "../../src/util/color"

describe("Color.isValidHex", () => {
  test("accepts valid 6-digit hex codes", () => {
    expect(Color.isValidHex("#ff5733")).toBe(true)
    expect(Color.isValidHex("#000000")).toBe(true)
    expect(Color.isValidHex("#FFFFFF")).toBe(true)
    expect(Color.isValidHex("#aAbBcC")).toBe(true)
  })

  test("rejects 3-digit shorthand hex", () => {
    // Users coming from CSS might try #FFF — this must be rejected
    // because hexToRgb assumes 6-digit format
    expect(Color.isValidHex("#FFF")).toBe(false)
    expect(Color.isValidHex("#abc")).toBe(false)
  })

  test("rejects missing hash prefix", () => {
    expect(Color.isValidHex("ff5733")).toBe(false)
  })

  test("rejects empty, undefined, and null-ish values", () => {
    expect(Color.isValidHex("")).toBe(false)
    expect(Color.isValidHex(undefined)).toBe(false)
  })

  test("rejects hex with invalid characters", () => {
    expect(Color.isValidHex("#gggggg")).toBe(false)
    expect(Color.isValidHex("#12345z")).toBe(false)
  })

  test("rejects hex with wrong length", () => {
    expect(Color.isValidHex("#1234567")).toBe(false)
    expect(Color.isValidHex("#12345")).toBe(false)
  })
})

describe("Color.hexToRgb", () => {
  test("converts standard hex to correct RGB", () => {
    expect(Color.hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 })
    expect(Color.hexToRgb("#00ff00")).toEqual({ r: 0, g: 255, b: 0 })
    expect(Color.hexToRgb("#0000ff")).toEqual({ r: 0, g: 0, b: 255 })
  })

  test("handles boundary values", () => {
    expect(Color.hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 })
    expect(Color.hexToRgb("#ffffff")).toEqual({ r: 255, g: 255, b: 255 })
  })

  test("handles mixed case", () => {
    expect(Color.hexToRgb("#AaBbCc")).toEqual({ r: 170, g: 187, b: 204 })
  })
})

describe("Color.hexToAnsiBold", () => {
  test("produces correct ANSI escape for valid hex", () => {
    const result = Color.hexToAnsiBold("#ff0000")
    expect(result).toBe("\x1b[38;2;255;0;0m\x1b[1m")
  })

  test("returns undefined for invalid hex, preventing NaN in ANSI sequences", () => {
    // Key safety test: without isValidHex guard, hexToRgb("#bad") would
    // produce NaN values in the escape sequence, corrupting terminal output
    expect(Color.hexToAnsiBold("#bad")).toBeUndefined()
    expect(Color.hexToAnsiBold("")).toBeUndefined()
    expect(Color.hexToAnsiBold(undefined)).toBeUndefined()
  })
})
