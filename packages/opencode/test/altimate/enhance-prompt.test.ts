import { describe, expect, test } from "bun:test"
import { clean, stripThinkTags } from "../../src/altimate/enhance-prompt"

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

  test("handles code fences with trailing whitespace", () => {
    expect(clean("  ```\nenhanced prompt\n```  ")).toBe("enhanced prompt")
  })

  test("preserves inner code blocks", () => {
    const input = "Run this:\n```sql\nSELECT 1\n```\nThen verify."
    expect(clean(input)).toBe("Run this:\n```sql\nSELECT 1\n```\nThen verify.")
  })

  test("handles whitespace-only string", () => {
    expect(clean("   ")).toBe("")
  })

  test("handles code fence with no newline before content", () => {
    expect(clean("```enhanced prompt```")).toBe("```enhanced prompt```")
  })

  test("handles single backtick quotes (not code fences)", () => {
    expect(clean("`enhanced prompt`")).toBe("`enhanced prompt`")
  })

  test("strips quotes from multiline content", () => {
    expect(clean('"First line.\nSecond line."')).toBe("First line.\nSecond line.")
  })

  test("does not strip mismatched quotes", () => {
    expect(clean("'enhanced prompt\"")).toBe("'enhanced prompt\"")
  })

  test("handles nested quotes inside code fences", () => {
    // After fence stripping, quote stripping also triggers on surrounding quotes
    expect(clean('```\n\'inner quoted\'\n```')).toBe("inner quoted")
  })
})

describe("enhance-prompt stripThinkTags()", () => {
  test("removes single think block", () => {
    expect(stripThinkTags("<think>reasoning here</think>actual prompt")).toBe("actual prompt")
  })

  test("removes think block with trailing whitespace", () => {
    expect(stripThinkTags("<think>reasoning</think>\n\nactual prompt")).toBe("actual prompt")
  })

  test("removes multiple think blocks", () => {
    const input = "<think>first</think>part one <think>second</think>part two"
    expect(stripThinkTags(input)).toBe("part one part two")
  })

  test("handles multiline think content", () => {
    const input = "<think>\nStep 1: analyze\nStep 2: rewrite\n</think>\nEnhanced prompt here"
    expect(stripThinkTags(input)).toBe("Enhanced prompt here")
  })

  test("returns text unchanged when no think tags", () => {
    expect(stripThinkTags("fix the auth bug")).toBe("fix the auth bug")
  })

  test("handles empty string", () => {
    expect(stripThinkTags("")).toBe("")
  })

  test("handles think tags with no content after", () => {
    expect(stripThinkTags("<think>reasoning only</think>")).toBe("")
  })

  test("handles nested angle brackets inside think tags", () => {
    expect(stripThinkTags("<think>check if x < 5 and y > 3</think>result")).toBe("result")
  })

  test("strips unclosed think tag (model hit token limit)", () => {
    expect(stripThinkTags("<think>reasoning that got cut off")).toBe("")
  })

  test("strips unclosed think tag with content before it", () => {
    expect(stripThinkTags("good content <think>trailing reasoning")).toBe("good content ")
  })
})

describe("enhance-prompt combined pipeline", () => {
  test("strips think tags then code fences then quotes", () => {
    const input = '<think>reasoning</think>```\n"enhanced prompt"\n```'
    const result = clean(stripThinkTags(input).trim())
    expect(result).toBe("enhanced prompt")
  })

  test("strips think tags and preserves plain text", () => {
    const input = "<think>let me think about this</think>Fix the failing dbt test by checking the schema."
    const result = clean(stripThinkTags(input).trim())
    expect(result).toBe("Fix the failing dbt test by checking the schema.")
  })

  test("handles think tags with code-fenced response", () => {
    const input = "<think>The user wants to fix a test</think>\n```text\nInvestigate the failing test.\n```"
    const result = clean(stripThinkTags(input).trim())
    expect(result).toBe("Investigate the failing test.")
  })

  test("handles clean output that is empty after stripping", () => {
    const input = '<think>everything is reasoning</think>```\n\n```'
    const result = clean(stripThinkTags(input).trim())
    expect(result).toBe("")
  })

  test("preserves content when no wrapping detected", () => {
    const input = "Add a created_at timestamp column to the users dbt model."
    const result = clean(stripThinkTags(input).trim())
    expect(result).toBe("Add a created_at timestamp column to the users dbt model.")
  })
})
