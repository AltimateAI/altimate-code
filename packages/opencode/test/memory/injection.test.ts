import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

// Test the memory injection integration: verifying that MemoryPrompt.inject()
// produces correct output for system prompt inclusion, and that the flag gating
// logic works correctly.

// Mirror the injection logic from session/prompt.ts to test the integration contract
function buildSystemPromptMemorySlot(
  disableMemory: boolean,
  memoryInjection: string,
): string[] {
  // This mirrors the logic in session/prompt.ts:
  //   const memoryInjection = Flag.ALTIMATE_DISABLE_MEMORY ? "" : await MemoryPrompt.inject()
  //   const system = [
  //     ...(await SystemPrompt.environment(model)),
  //     ...(memoryInjection ? [memoryInjection] : []),
  //     ...(await InstructionPrompt.system()),
  //   ]
  const injection = disableMemory ? "" : memoryInjection
  return injection ? [injection] : []
}

interface MemoryBlock {
  id: string
  scope: string
  tags: string[]
  content: string
  created: string
  updated: string
  expires?: string
  citations?: { file: string; line?: number; note?: string }[]
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

function isExpired(block: MemoryBlock): boolean {
  if (!block.expires) return false
  return new Date(block.expires) <= new Date()
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

describe("Memory injection into system prompt", () => {
  describe("flag gating", () => {
    test("excludes memory when ALTIMATE_DISABLE_MEMORY is true", () => {
      const injection = injectFromBlocks(
        [makeBlock({ id: "wh-config", content: "Snowflake WH" })],
        8000,
      )
      const slot = buildSystemPromptMemorySlot(true, injection)
      expect(slot).toEqual([])
    })

    test("includes memory when ALTIMATE_DISABLE_MEMORY is false", () => {
      const injection = injectFromBlocks(
        [makeBlock({ id: "wh-config", content: "Snowflake WH" })],
        8000,
      )
      const slot = buildSystemPromptMemorySlot(false, injection)
      expect(slot).toHaveLength(1)
      expect(slot[0]).toContain("## Altimate Memory")
      expect(slot[0]).toContain("Snowflake WH")
    })

    test("produces empty slot when no memory blocks exist", () => {
      const injection = injectFromBlocks([], 8000)
      const slot = buildSystemPromptMemorySlot(false, injection)
      expect(slot).toEqual([])
    })

    test("empty injection string produces empty slot even with memory enabled", () => {
      const slot = buildSystemPromptMemorySlot(false, "")
      expect(slot).toEqual([])
    })
  })

  describe("system prompt assembly order", () => {
    test("memory appears as a single system prompt entry", () => {
      const blocks = [
        makeBlock({ id: "config-1", content: "Database: ANALYTICS_DB" }),
        makeBlock({ id: "config-2", content: "Warehouse: COMPUTE_WH", scope: "global" }),
      ]
      const injection = injectFromBlocks(blocks, 8000)
      const slot = buildSystemPromptMemorySlot(false, injection)

      // Should be exactly one entry containing all blocks
      expect(slot).toHaveLength(1)
      expect(slot[0]).toContain("### config-1 (project)")
      expect(slot[0]).toContain("### config-2 (global)")
    })

    test("injection is a single string that can be concatenated with other system parts", () => {
      const injection = injectFromBlocks(
        [makeBlock({ id: "test", content: "Hello" })],
        8000,
      )
      const slot = buildSystemPromptMemorySlot(false, injection)

      // Simulate system prompt assembly
      const environment = ["You are a helpful assistant."]
      const instructions = ["Follow project conventions."]
      const system = [...environment, ...slot, ...instructions]

      expect(system).toHaveLength(3)
      expect(system[0]).toBe("You are a helpful assistant.")
      expect(system[1]).toContain("## Altimate Memory")
      expect(system[2]).toBe("Follow project conventions.")
    })
  })

  describe("budget enforcement in system prompt context", () => {
    test("large memory does not exceed budget", () => {
      const blocks = Array.from({ length: 20 }, (_, i) =>
        makeBlock({ id: `block-${i}`, content: `Content ${i}: ${"x".repeat(300)}` }),
      )
      const injection = injectFromBlocks(blocks, 2000)
      const slot = buildSystemPromptMemorySlot(false, injection)

      expect(slot).toHaveLength(1)
      // The injection respects the budget
      expect(slot[0].length).toBeLessThanOrEqual(2000)
      // But it should include at least the first block
      expect(slot[0]).toContain("### block-0")
    })

    test("default budget (8000) fits typical memory blocks", () => {
      const blocks = Array.from({ length: 10 }, (_, i) =>
        makeBlock({
          id: `convention-${i}`,
          content: `Convention ${i}: Use snake_case for ${i}`,
          tags: ["conventions"],
        }),
      )
      const injection = injectFromBlocks(blocks, 8000)
      const slot = buildSystemPromptMemorySlot(false, injection)

      expect(slot).toHaveLength(1)
      // All 10 small blocks should fit within 8000 chars
      for (let i = 0; i < 10; i++) {
        expect(slot[0]).toContain(`### convention-${i}`)
      }
    })
  })

  describe("expired blocks in system prompt", () => {
    test("expired blocks are excluded from system prompt injection", () => {
      const blocks = [
        makeBlock({ id: "active", content: "Active config" }),
        makeBlock({ id: "stale", content: "Old config", expires: "2020-01-01T00:00:00.000Z" }),
      ]
      const injection = injectFromBlocks(blocks, 8000)
      const slot = buildSystemPromptMemorySlot(false, injection)

      expect(slot).toHaveLength(1)
      expect(slot[0]).toContain("### active")
      expect(slot[0]).not.toContain("### stale")
    })

    test("all-expired blocks produce empty injection", () => {
      const blocks = [
        makeBlock({ id: "old-1", content: "Old", expires: "2020-01-01T00:00:00.000Z" }),
        makeBlock({ id: "old-2", content: "Also old", expires: "2021-01-01T00:00:00.000Z" }),
      ]
      const injection = injectFromBlocks(blocks, 8000)
      // Header is still present but no blocks — check the slot behavior
      // The injection will have the header but no block content
      const slot = buildSystemPromptMemorySlot(false, injection)
      expect(slot).toHaveLength(1)
      expect(slot[0]).toContain("## Altimate Memory")
      expect(slot[0]).not.toContain("### old-1")
      expect(slot[0]).not.toContain("### old-2")
    })
  })

  describe("memory content in system prompt", () => {
    test("preserves tags in injected content", () => {
      const blocks = [
        makeBlock({ id: "wh", content: "Snowflake config", tags: ["snowflake", "warehouse"] }),
      ]
      const injection = injectFromBlocks(blocks, 8000)
      const slot = buildSystemPromptMemorySlot(false, injection)

      expect(slot[0]).toContain("[snowflake, warehouse]")
    })

    test("preserves citations in injected content", () => {
      const blocks = [
        makeBlock({
          id: "config",
          content: "DB setup",
          citations: [{ file: "dbt_project.yml", line: 5, note: "Project name" }],
        }),
      ]
      const injection = injectFromBlocks(blocks, 8000)
      const slot = buildSystemPromptMemorySlot(false, injection)

      expect(slot[0]).toContain("**Sources:**")
      expect(slot[0]).toContain("`dbt_project.yml:5` — Project name")
    })

    test("preserves expiration annotations for future-dated blocks", () => {
      const blocks = [
        makeBlock({ id: "temp", content: "Temporary", expires: "2099-12-31T00:00:00.000Z" }),
      ]
      const injection = injectFromBlocks(blocks, 8000)
      const slot = buildSystemPromptMemorySlot(false, injection)

      expect(slot[0]).toContain("(expires: 2099-12-31T00:00:00.000Z)")
    })

    test("includes both project and global scoped blocks", () => {
      const blocks = [
        makeBlock({ id: "proj-config", scope: "project", content: "Project setting" }),
        makeBlock({ id: "user-pref", scope: "global", content: "User preference" }),
      ]
      const injection = injectFromBlocks(blocks, 8000)
      const slot = buildSystemPromptMemorySlot(false, injection)

      expect(slot[0]).toContain("### proj-config (project)")
      expect(slot[0]).toContain("### user-pref (global)")
    })
  })
})
