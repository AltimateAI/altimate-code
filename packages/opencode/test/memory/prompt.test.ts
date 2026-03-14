import { describe, test, expect } from "bun:test"

// Test the prompt formatting and injection logic directly
// without needing Instance context

interface MemoryBlock {
  id: string
  scope: string
  tags: string[]
  content: string
  created: string
  updated: string
}

function formatBlock(block: { id: string; scope: string; tags: string[]; content: string }): string {
  const tagsStr = block.tags.length > 0 ? ` [${block.tags.join(", ")}]` : ""
  return `### ${block.id} (${block.scope})${tagsStr}\n${block.content}`
}

function injectFromBlocks(blocks: MemoryBlock[], budget: number): string {
  if (blocks.length === 0) return ""

  const header = "## Agent Memory\n\nThe following memory blocks were saved from previous sessions:\n"
  let result = header
  let used = header.length

  for (const block of blocks) {
    const formatted = formatBlock(block)
    const needed = formatted.length + 2
    if (used + needed > budget) break
    result += "\n" + formatted + "\n"
    used += needed
  }

  return result
}

function makeBlock(overrides: Partial<MemoryBlock> = {}): MemoryBlock {
  return {
    id: "test-block",
    scope: "project",
    tags: [],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    content: "Test content",
    ...overrides,
  }
}

describe("MemoryPrompt", () => {
  describe("formatBlock", () => {
    test("formats block without tags", () => {
      const result = formatBlock({ id: "warehouse-config", scope: "project", tags: [], content: "Snowflake setup" })
      expect(result).toBe("### warehouse-config (project)\nSnowflake setup")
    })

    test("formats block with tags", () => {
      const result = formatBlock({
        id: "naming",
        scope: "global",
        tags: ["dbt", "conventions"],
        content: "Use stg_ prefix",
      })
      expect(result).toBe("### naming (global) [dbt, conventions]\nUse stg_ prefix")
    })

    test("formats block with multiline content", () => {
      const content = "## Config\n\n- Provider: Snowflake\n- Database: ANALYTICS"
      const result = formatBlock({ id: "config", scope: "project", tags: [], content })
      expect(result).toContain("### config (project)")
      expect(result).toContain("- Provider: Snowflake")
    })
  })

  describe("inject", () => {
    test("returns empty string for no blocks", () => {
      const result = injectFromBlocks([], 8000)
      expect(result).toBe("")
    })

    test("includes header and blocks", () => {
      const blocks = [makeBlock({ id: "block-1", content: "Content 1" })]
      const result = injectFromBlocks(blocks, 8000)
      expect(result).toContain("## Agent Memory")
      expect(result).toContain("### block-1 (project)")
      expect(result).toContain("Content 1")
    })

    test("includes multiple blocks", () => {
      const blocks = [
        makeBlock({ id: "block-1", content: "Content 1" }),
        makeBlock({ id: "block-2", content: "Content 2", scope: "global" }),
      ]
      const result = injectFromBlocks(blocks, 8000)
      expect(result).toContain("### block-1 (project)")
      expect(result).toContain("### block-2 (global)")
    })

    test("respects budget and truncates blocks that dont fit", () => {
      const blocks = [
        makeBlock({ id: "small", content: "Short" }),
        makeBlock({ id: "big", content: "x".repeat(5000) }),
      ]
      // Set a budget that fits the header + first block but not the second
      const result = injectFromBlocks(blocks, 200)
      expect(result).toContain("### small (project)")
      expect(result).not.toContain("### big (project)")
    })

    test("fits exactly within budget", () => {
      const block = makeBlock({ id: "a", content: "Hi" })
      const formatted = formatBlock(block)
      const header = "## Agent Memory\n\nThe following memory blocks were saved from previous sessions:\n"
      const exactBudget = header.length + formatted.length + 2

      const result = injectFromBlocks([block], exactBudget)
      expect(result).toContain("### a (project)")
    })

    test("returns only header if no blocks fit", () => {
      const blocks = [makeBlock({ id: "big", content: "x".repeat(1000) })]
      // Budget smaller than header + any block
      const result = injectFromBlocks(blocks, 80)
      expect(result).toContain("## Agent Memory")
      expect(result).not.toContain("### big")
    })
  })
})
