import { describe, expect, test } from "bun:test"
import { clean } from "../../src/altimate/enhance-prompt"

describe("enhance-prompt clean()", () => {
  test("strips markdown code fences", () => {
    expect(clean("```\nfixed prompt\n```")).toBe("fixed prompt")
  })

  test("strips code fences with language tag", () => {
    expect(clean("```text\nenhanced prompt\n```")).toBe("enhanced prompt")
  })

  test("strips surrounding single quotes", () => {
    expect(clean("'enhanced prompt'")).toBe("enhanced prompt")
  })

  test("strips surrounding double quotes", () => {
    expect(clean('"enhanced prompt"')).toBe("enhanced prompt")
  })

  test("trims whitespace", () => {
    expect(clean("  enhanced prompt  ")).toBe("enhanced prompt")
  })

  test("handles combined wrapping", () => {
    expect(clean('```\n"enhanced prompt"\n```')).toBe("enhanced prompt")
  })

  test("returns plain text unchanged", () => {
    expect(clean("fix the auth bug")).toBe("fix the auth bug")
  })

  test("handles empty string", () => {
    expect(clean("")).toBe("")
  })

  test("handles multiline content", () => {
    const input = "```\nFirst do X.\nThen do Y.\n```"
    expect(clean(input)).toBe("First do X.\nThen do Y.")
  })
})
