import { describe, test, expect } from "bun:test"
import {
  parseMarkdownSections,
  slugify,
} from "../../../src/altimate/tools/training-import"

describe("slugify", () => {
  test("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("My SQL Style Guide")).toBe("my-sql-style-guide")
  })

  test("removes special characters", () => {
    expect(slugify("Naming Conventions (v2.1)")).toBe("naming-conventions-v21")
  })

  test("collapses multiple spaces", () => {
    expect(slugify("Use   consistent   naming")).toBe("use-consistent-naming")
  })

  test("strips leading and trailing hyphens from realistic input", () => {
    // Parentheses-only prefix becomes hyphens that get trimmed
    expect(slugify("(Naming)")).toBe("naming")
    expect(slugify("---leading---")).toBe("leading")
  })

  test("truncates to 64 characters", () => {
    const long = "a".repeat(100)
    expect(slugify(long).length).toBe(64)
  })

  test("handles empty string with fallback", () => {
    expect(slugify("")).toBe("untitled")
  })

  test("handles string with only special chars with fallback", () => {
    expect(slugify("!@#$%")).toBe("untitled")
  })

  test("handles unicode characters (normalizes accents via NFKD)", () => {
    expect(slugify("caf\u00e9 rules")).toBe("cafe-rules")
    expect(slugify("na\u00efve approach")).toBe("naive-approach")
  })
})

describe("parseMarkdownSections", () => {
  test("parses simple H2 sections", () => {
    const md = `## Naming Convention\nUse snake_case for all columns.\n\n## Type Rules\nAlways use NUMERIC(18,2) for amounts.\n`
    const sections = parseMarkdownSections(md)
    expect(sections).toHaveLength(2)
    expect(sections[0].name).toBe("naming-convention")
    expect(sections[0].content).toContain("Use snake_case")
    expect(sections[1].name).toBe("type-rules")
    expect(sections[1].content).toContain("NUMERIC(18,2)")
  })

  test("H1 context is prepended to H2 sections", () => {
    const md = `# SQL Style Guide\n\n## Column Naming\nUse lowercase with underscores.\n\n## Table Naming\nUse plural nouns.\n`
    const sections = parseMarkdownSections(md)
    expect(sections).toHaveLength(2)
    expect(sections[0].content).toContain("Context: SQL Style Guide")
    expect(sections[0].content).toContain("Use lowercase with underscores.")
    expect(sections[1].content).toContain("Context: SQL Style Guide")
  })

  test("H1 context updates when a new H1 appears", () => {
    const md = `# Part 1\n\n## Rule A\nContent A.\n\n# Part 2\n\n## Rule B\nContent B.\n`
    const sections = parseMarkdownSections(md)
    expect(sections).toHaveLength(2)
    expect(sections[0].content).toContain("Context: Part 1")
    expect(sections[1].content).toContain("Context: Part 2")
  })

  test("returns empty for markdown with no H2 headings", () => {
    const md = `# Just a Title\n\nSome paragraph text without any H2 sections.\n\n### H3 heading (not H2)\nMore text.\n`
    const sections = parseMarkdownSections(md)
    expect(sections).toHaveLength(0)
  })

  test("returns empty for empty string", () => {
    expect(parseMarkdownSections("")).toHaveLength(0)
  })

  test("skips H2 sections with empty content", () => {
    const md = `## Empty Section\n## Non-Empty Section\nSome content here.\n`
    const sections = parseMarkdownSections(md)
    // "Empty Section" has no content lines before next H2
    expect(sections).toHaveLength(1)
    expect(sections[0].name).toBe("non-empty-section")
  })

  test("H3 lines are included as content within H2 section", () => {
    const md = `## Main Rule\n\n### Sub-rule A\nDetails about A.\n\n### Sub-rule B\nDetails about B.\n`
    const sections = parseMarkdownSections(md)
    expect(sections).toHaveLength(1)
    expect(sections[0].content).toContain("### Sub-rule A")
    expect(sections[0].content).toContain("Details about A.")
    expect(sections[0].content).toContain("### Sub-rule B")
  })

  test("last section is captured", () => {
    const md = `## Only Section\nContent of the only section.`
    const sections = parseMarkdownSections(md)
    expect(sections).toHaveLength(1)
    expect(sections[0].content).toBe("Content of the only section.")
  })

  test("H2 names are slugified", () => {
    const md = `## My Complex (Section) Name!\nContent here.\n\n## v2.1 Naming\nVersioned heading.\n`
    const sections = parseMarkdownSections(md)
    expect(sections[0].name).toBe("my-complex-section-name")
    // Dots in version headings are stripped: "v2.1" \u2192 "v21" (not "v2-1")
    expect(sections[1].name).toBe("v21-naming")
  })

  test("content is trimmed", () => {
    const md = `## Padded Section\n\n  Content with leading whitespace preserved per-line.\n\n`
    const sections = parseMarkdownSections(md)
    // The joined content should be trimmed (no leading/trailing blank lines)
    expect(sections[0].content).not.toMatch(/^\n/)
    expect(sections[0].content).not.toMatch(/\n$/)
  })

  test("multiple H1s without H2s produce no sections", () => {
    const md = `# Header 1\nIntro text.\n\n# Header 2\nMore intro text.\n`
    const sections = parseMarkdownSections(md)
    expect(sections).toHaveLength(0)
  })
})
