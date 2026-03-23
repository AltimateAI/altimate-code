/**
 * Tests for the training_import tool — markdown parsing, section extraction,
 * capacity enforcement, and dry-run preview.
 *
 * Mocks fs.readFile, TrainingStore, and TrainingPrompt so we can exercise
 * the parsing and import logic without a real filesystem or memory store.
 */
import { describe, test, expect, spyOn, afterAll, beforeEach } from "bun:test"
import { TrainingImportTool } from "../../src/altimate/tools/training-import"
import { TrainingStore } from "../../src/altimate/training"
import { TrainingPrompt } from "../../src/altimate/training"
import { TRAINING_MAX_PATTERNS_PER_KIND } from "../../src/altimate/training"
import { SessionID, MessageID } from "../../src/session/schema"
import * as fs from "fs/promises"

// Disable telemetry
beforeEach(() => {
  process.env.ALTIMATE_TELEMETRY_DISABLED = "true"
})
afterAll(() => {
  delete process.env.ALTIMATE_TELEMETRY_DISABLED
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

// --- Spies ---
let readFileSpy: ReturnType<typeof spyOn>
let countSpy: ReturnType<typeof spyOn>
let saveSpy: ReturnType<typeof spyOn>
let budgetSpy: ReturnType<typeof spyOn>

function setupMocks(opts: {
  fileContent: string
  currentCount?: number
  saveShouldFail?: boolean
}) {
  readFileSpy?.mockRestore()
  countSpy?.mockRestore()
  saveSpy?.mockRestore()
  budgetSpy?.mockRestore()

  readFileSpy = spyOn(fs, "readFile").mockImplementation(async () => opts.fileContent as any)
  countSpy = spyOn(TrainingStore, "count").mockImplementation(async () => ({
    standard: opts.currentCount ?? 0,
    glossary: opts.currentCount ?? 0,
    playbook: opts.currentCount ?? 0,
    context: opts.currentCount ?? 0,
    rule: opts.currentCount ?? 0,
    pattern: opts.currentCount ?? 0,
    context: opts.currentCount ?? 0,
    rule: opts.currentCount ?? 0,
  }))
  saveSpy = spyOn(TrainingStore, "save").mockImplementation(async () => {
    if (opts.saveShouldFail) throw new Error("store write failed")
    return {} as any
  })
  budgetSpy = spyOn(TrainingPrompt, "budgetUsage").mockImplementation(async () => ({
    used: 500,
    budget: 8000,
    percent: 6,
  }))
}

afterAll(() => {
  readFileSpy?.mockRestore()
  countSpy?.mockRestore()
  saveSpy?.mockRestore()
  budgetSpy?.mockRestore()
})

describe("training_import: markdown parsing (dry_run)", () => {
  test("extracts H2 sections as entries", async () => {
    setupMocks({
      fileContent: [
        "# SQL Style Guide",
        "",
        "## Naming Conventions",
        "Use snake_case for all identifiers.",
        "",
        "## SELECT Formatting",
        "Always list columns explicitly.",
        "Never use SELECT *.",
      ].join("\n"),
    })

    const tool = await TrainingImportTool.init()
    const result = await tool.execute(
      { file_path: "style-guide.md", kind: "standard", scope: "project", dry_run: true, max_entries: 20 },
      ctx,
    )
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.dry_run).toBe(true)
    expect(result.metadata.count).toBe(2)
    expect(result.output).toContain("naming-conventions")
    expect(result.output).toContain("select-formatting")
  })

  test("includes H1 context prefix in section content", async () => {
    setupMocks({
      fileContent: [
        "# Data Engineering Standards",
        "",
        "## CTE Usage",
        "Always use CTEs instead of subqueries.",
      ].join("\n"),
    })

    const tool = await TrainingImportTool.init()
    const result = await tool.execute(
      { file_path: "doc.md", kind: "standard", scope: "project", dry_run: true, max_entries: 20 },
      ctx,
    )
    expect(result.metadata.count).toBe(1)
    // The H1 title should appear as context inside the entry
    expect(result.output).toContain("Context: Data Engineering Standards")
  })

  test("returns NO SECTIONS when markdown has no H2 headings", async () => {
    setupMocks({
      fileContent: [
        "# Just a Title",
        "",
        "Some body text but no ## headings.",
        "",
        "More text here.",
      ].join("\n"),
    })

    const tool = await TrainingImportTool.init()
    const result = await tool.execute(
      { file_path: "empty.md", kind: "glossary", scope: "project", dry_run: true, max_entries: 20 },
      ctx,
    )
    expect(result.title).toContain("NO SECTIONS")
    expect(result.metadata.success).toBe(false)
    expect(result.metadata.count).toBe(0)
  })

  test("includes H2 sections even when content is only whitespace", async () => {
    // NOTE: parseMarkdownSections checks currentContent.length > 0 (array length)
    // but does NOT check whether the trimmed content is empty. This means a
    // section with only blank lines still gets included. This documents the
    // actual behavior — a future fix could skip truly empty sections.
    setupMocks({
      fileContent: [
        "## Empty Section",
        "",
        "## Section With Content",
        "This has actual content.",
      ].join("\n"),
    })

    const tool = await TrainingImportTool.init()
    const result = await tool.execute(
      { file_path: "mixed.md", kind: "standard", scope: "project", dry_run: true, max_entries: 20 },
      ctx,
    )
    expect(result.metadata.count).toBe(2)
    expect(result.output).toContain("section-with-content")
    // Empty section is included with 0 chars after trim
    expect(result.output).toContain("empty-section")
  })

  test("respects max_entries limit", async () => {
    const sections = Array.from({ length: 10 }, (_, i) =>
      `## Section ${i}\nContent for section ${i}.`
    ).join("\n\n")
    setupMocks({ fileContent: sections })

    const tool = await TrainingImportTool.init()
    const result = await tool.execute(
      { file_path: "many.md", kind: "standard", scope: "project", dry_run: true, max_entries: 3 },
      ctx,
    )
    expect(result.metadata.count).toBe(3)
  })
})

describe("training_import: capacity enforcement", () => {
  test("warns when capacity is nearly full", async () => {
    setupMocks({
      fileContent: [
        "## Entry 1",
        "Content 1",
        "",
        "## Entry 2",
        "Content 2",
        "",
        "## Entry 3",
        "Content 3",
      ].join("\n"),
      currentCount: TRAINING_MAX_PATTERNS_PER_KIND - 2,
    })

    const tool = await TrainingImportTool.init()
    const result = await tool.execute(
      { file_path: "doc.md", kind: "standard", scope: "project", dry_run: true, max_entries: 20 },
      ctx,
    )
    // Only 2 slots available, 3 entries found — should show WARNING
    expect(result.metadata.count).toBe(2)
    expect(result.output).toContain("WARNING")
    expect(result.output).toContain("SKIP")
  })
})

describe("training_import: actual import (dry_run=false)", () => {
  test("calls TrainingStore.save for each entry", async () => {
    setupMocks({
      fileContent: [
        "## Naming Rules",
        "Use snake_case.",
        "",
        "## Join Style",
        "Always use explicit JOIN.",
      ].join("\n"),
    })

    const tool = await TrainingImportTool.init()
    const result = await tool.execute(
      { file_path: "guide.md", kind: "standard", scope: "project", dry_run: false, max_entries: 20 },
      ctx,
    )
    expect(result.metadata.success).toBe(true)
    expect(result.metadata.count).toBe(2)
    expect(saveSpy).toHaveBeenCalledTimes(2)
    expect(result.output).toContain("Imported 2")
    expect(result.output).toContain("Training usage:")
  })

  test("reports errors when TrainingStore.save fails", async () => {
    setupMocks({
      fileContent: [
        "## Rule A",
        "Content A",
      ].join("\n"),
      saveShouldFail: true,
    })

    const tool = await TrainingImportTool.init()
    const result = await tool.execute(
      { file_path: "fail.md", kind: "standard", scope: "project", dry_run: false, max_entries: 20 },
      ctx,
    )
    expect(result.metadata.success).toBe(true) // tool itself succeeds
    expect(result.metadata.count).toBe(0) // but no entries saved
    expect(result.metadata.skipped).toBe(1)
    expect(result.output).toContain("FAIL")
  })
})

describe("training_import: slugify edge cases", () => {
  test("handles special characters and unicode in headings", async () => {
    setupMocks({
      fileContent: [
        "## CTE Best Practices (v2.0) \u2014 Updated!",
        "Always name CTEs descriptively.",
      ].join("\n"),
    })

    const tool = await TrainingImportTool.init()
    const result = await tool.execute(
      { file_path: "special.md", kind: "standard", scope: "project", dry_run: true, max_entries: 20 },
      ctx,
    )
    expect(result.metadata.count).toBe(1)
    // Slugified name should strip special chars and use hyphens
    expect(result.output).toContain("cte-best-practices-v20-updated")
  })
})

describe("training_import: error handling", () => {
  test("returns ERROR when file cannot be read", async () => {
    readFileSpy?.mockRestore()
    readFileSpy = spyOn(fs, "readFile").mockImplementation(async () => {
      throw new Error("ENOENT: no such file")
    })

    const tool = await TrainingImportTool.init()
    const result = await tool.execute(
      { file_path: "nonexistent.md", kind: "standard", scope: "project", dry_run: true, max_entries: 20 },
      ctx,
    )
    expect(result.title).toContain("ERROR")
    expect(result.metadata.success).toBe(false)
    expect(result.output).toContain("ENOENT")
  })
})
