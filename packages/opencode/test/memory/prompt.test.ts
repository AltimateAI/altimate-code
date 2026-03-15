import { describe, test, expect } from "bun:test"

// Test the prompt formatting and injection logic directly
// without needing Instance context

interface Citation {
  file: string
  line?: number
  note?: string
}

interface MemoryBlock {
  id: string
  scope: string
  tags: string[]
  content: string
  created: string
  updated: string
  expires?: string
  citations?: Citation[]
}

function isExpired(block: MemoryBlock): boolean {
  if (!block.expires) return false
  return new Date(block.expires) <= new Date()
}

function formatBlock(block: MemoryBlock): string {
  const tagsStr = block.tags.length > 0 ? ` [${block.tags.join(", ")}]` : ""
  const expiresStr = block.expires ? ` (expires: ${block.expires})` : ""
  let result = `### ${block.id} (${block.scope})${tagsStr}${expiresStr}\n${block.content}`

  if (block.citations && block.citations.length > 0) {
    const citationLines = block.citations.map((c) => {
      const lineStr = c.line ? `:${c.line}` : ""
      const noteStr = c.note ? ` — ${c.note}` : ""
      return `- \`${c.file}${lineStr}\`${noteStr}`
    })
    result += "\n\n**Sources:**\n" + citationLines.join("\n")
  }

  return result
}

function injectFromBlocks(blocks: MemoryBlock[], budget: number): string {
  if (blocks.length === 0) return ""

  const header = "## Altimate Memory\n\nThe following memory blocks were saved from previous sessions:\n"
  let result = header
  let used = header.length

  for (const block of blocks) {
    if (isExpired(block)) continue
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
      const result = formatBlock({ id: "warehouse-config", scope: "project", tags: [], content: "Snowflake setup", created: "", updated: "" })
      expect(result).toBe("### warehouse-config (project)\nSnowflake setup")
    })

    test("formats block with tags", () => {
      const result = formatBlock({
        id: "naming",
        scope: "global",
        tags: ["dbt", "conventions"],
        content: "Use stg_ prefix",
        created: "",
        updated: "",
      })
      expect(result).toBe("### naming (global) [dbt, conventions]\nUse stg_ prefix")
    })

    test("formats block with multiline content", () => {
      const content = "## Config\n\n- Provider: Snowflake\n- Database: ANALYTICS"
      const result = formatBlock({ id: "config", scope: "project", tags: [], content, created: "", updated: "" })
      expect(result).toContain("### config (project)")
      expect(result).toContain("- Provider: Snowflake")
    })

    test("formats block with expires", () => {
      const result = formatBlock(makeBlock({ id: "temp", expires: "2027-06-01T00:00:00.000Z" }))
      expect(result).toContain("(expires: 2027-06-01T00:00:00.000Z)")
    })

    test("formats block without expires (no annotation)", () => {
      const result = formatBlock(makeBlock({ id: "permanent" }))
      expect(result).not.toContain("expires:")
    })

    test("formats block with citations", () => {
      const citations: Citation[] = [
        { file: "src/config.ts", line: 42, note: "Warehouse constant" },
        { file: "dbt_project.yml" },
      ]
      const result = formatBlock(makeBlock({ id: "cited", citations }))
      expect(result).toContain("**Sources:**")
      expect(result).toContain("- `src/config.ts:42` — Warehouse constant")
      expect(result).toContain("- `dbt_project.yml`")
    })

    test("formats citation with line but no note", () => {
      const citations: Citation[] = [{ file: "models/orders.sql", line: 10 }]
      const result = formatBlock(makeBlock({ citations }))
      expect(result).toContain("- `models/orders.sql:10`")
      expect(result).not.toContain("—")
    })

    test("formats citation with note but no line", () => {
      const citations: Citation[] = [{ file: "schema.yml", note: "Model definition" }]
      const result = formatBlock(makeBlock({ citations }))
      expect(result).toContain("- `schema.yml` — Model definition")
    })

    test("formats block with no citations (no Sources section)", () => {
      const result = formatBlock(makeBlock())
      expect(result).not.toContain("**Sources:**")
    })

    test("formats block with tags, expires, and citations together", () => {
      const result = formatBlock(makeBlock({
        id: "full",
        tags: ["snowflake"],
        expires: "2027-01-01T00:00:00.000Z",
        citations: [{ file: "a.sql", line: 1 }],
        content: "Full block",
      }))
      expect(result).toContain("### full (project) [snowflake] (expires: 2027-01-01T00:00:00.000Z)")
      expect(result).toContain("Full block")
      expect(result).toContain("**Sources:**")
      expect(result).toContain("- `a.sql:1`")
    })
  })

  describe("inject", () => {
    test("returns empty string for no blocks", () => {
      const result = injectFromBlocks([], 8000)
      expect(result).toBe("")
    })

    test("uses Altimate Memory header", () => {
      const blocks = [makeBlock({ id: "block-1", content: "Content 1" })]
      const result = injectFromBlocks(blocks, 8000)
      expect(result).toContain("## Altimate Memory")
      expect(result).toContain("previous sessions")
    })

    test("includes header and blocks", () => {
      const blocks = [makeBlock({ id: "block-1", content: "Content 1" })]
      const result = injectFromBlocks(blocks, 8000)
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
      const result = injectFromBlocks(blocks, 200)
      expect(result).toContain("### small (project)")
      expect(result).not.toContain("### big (project)")
    })

    test("fits exactly within budget", () => {
      const block = makeBlock({ id: "a", content: "Hi" })
      const formatted = formatBlock(block)
      const header = "## Altimate Memory\n\nThe following memory blocks were saved from previous sessions:\n"
      const exactBudget = header.length + formatted.length + 2

      const result = injectFromBlocks([block], exactBudget)
      expect(result).toContain("### a (project)")
    })

    test("returns only header if no blocks fit", () => {
      const blocks = [makeBlock({ id: "big", content: "x".repeat(1000) })]
      const result = injectFromBlocks(blocks, 80)
      expect(result).toContain("## Altimate Memory")
      expect(result).not.toContain("### big")
    })

    test("skips expired blocks during injection", () => {
      const blocks = [
        makeBlock({ id: "active", content: "Active block" }),
        makeBlock({ id: "expired", content: "Expired block", expires: "2020-01-01T00:00:00.000Z" }),
        makeBlock({ id: "also-active", content: "Also active" }),
      ]
      const result = injectFromBlocks(blocks, 8000)
      expect(result).toContain("### active")
      expect(result).toContain("### also-active")
      expect(result).not.toContain("### expired")
    })

    test("includes blocks with future expiry", () => {
      const blocks = [makeBlock({ id: "future", content: "Future block", expires: "2099-12-31T00:00:00.000Z" })]
      const result = injectFromBlocks(blocks, 8000)
      expect(result).toContain("### future")
      expect(result).toContain("(expires: 2099-12-31T00:00:00.000Z)")
    })

    test("includes citation-backed blocks in injection", () => {
      const blocks = [
        makeBlock({
          id: "cited",
          content: "Config info",
          citations: [{ file: "config.ts", line: 5, note: "Main config" }],
        }),
      ]
      const result = injectFromBlocks(blocks, 8000)
      expect(result).toContain("**Sources:**")
      expect(result).toContain("`config.ts:5`")
    })
  })
})
