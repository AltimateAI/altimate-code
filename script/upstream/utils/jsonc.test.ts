import { describe, test, expect } from "bun:test"
import { stripJsonComments, parseJsonc } from "./jsonc"

describe("stripJsonComments", () => {
  test("strips a line comment", () => {
    expect(stripJsonComments('{ "a": 1 } // trailing comment')).toBe('{ "a": 1 } ')
  })

  test("strips a block comment", () => {
    expect(stripJsonComments('{ /* comment */ "a": 1 }')).toBe('{  "a": 1 }')
  })

  test("does NOT strip // inside a string value not preceded by a colon (the old regex's bug)", () => {
    // The old `(^|[^:])\/\/.*$` heuristic only spared `//` immediately after
    // `:`. A bare string value containing `//` with no preceding `:` — e.g.
    // this one, where `//` follows a space, not a colon — was corrupted.
    const input = '{ "note": "see the note about // not a url here" }'
    expect(stripJsonComments(input)).toBe(input)
  })

  test("does not strip // inside a URL string value", () => {
    const input = '{ "url": "https://example.com/path" }'
    expect(stripJsonComments(input)).toBe(input)
  })

  test("does not strip /* inside a string value", () => {
    const input = '{ "desc": "a /* not a comment */ literally" }'
    expect(stripJsonComments(input)).toBe(input)
  })

  test("handles escaped quotes inside strings without ending the string early", () => {
    const input = String.raw`{ "s": "a \" then // still in string until next quote" }`
    expect(stripJsonComments(input)).toBe(input)
  })

  test("handles escaped backslash before a quote without misreading the escape", () => {
    // `\\"` is an escaped backslash followed by a real closing quote, not an
    // escaped quote. A naive scanner that only checks `ch === "\\"` without
    // also consuming the escaped character can desync on this.
    const input = String.raw`{ "s": "ends with backslash\\" } // real comment`
    const expected = String.raw`{ "s": "ends with backslash\\" } `
    expect(stripJsonComments(input)).toBe(expected)
  })

  test("mixed real comments and string content with // and /* */", () => {
    const input = [
      "// header comment",
      '{ "keep": "http://example.com", /* inline */ "n": 1 } // trailing',
    ].join("\n")
    const result = parseJsonc(input) as { keep: string; n: number }
    expect(result.keep).toBe("http://example.com")
    expect(result.n).toBe(1)
  })
})

describe("parseJsonc", () => {
  test("parses a JSONC array with comments and URL-bearing strings", () => {
    const text = `
      // top comment
      [
        /* entry */
        { "path": "https://example.com/a//b", "note": "keep this // literally" }
      ]
    `
    const parsed = parseJsonc(text) as Array<{ path: string; note: string }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0].path).toBe("https://example.com/a//b")
    expect(parsed[0].note).toBe("keep this // literally")
  })
})
