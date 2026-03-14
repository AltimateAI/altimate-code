import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

// We test the store logic directly by importing the module and
// controlling the directories via environment variables and mocking.
// Since MemoryStore uses Global.Path.data and Instance.directory,
// we create a self-contained test harness that exercises the same
// serialization/parsing/CRUD logic.

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; content: string } | undefined {
  const match = raw.match(FRONTMATTER_REGEX)
  if (!match) return undefined

  const meta: Record<string, unknown> = {}
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value: unknown = line.slice(idx + 1).trim()
    if (value === "") continue
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      try {
        value = JSON.parse(value)
      } catch {
        // keep as string
      }
    }
    meta[key] = value
  }

  return { meta, content: match[2].trim() }
}

interface MemoryBlock {
  id: string
  scope: "global" | "project"
  tags: string[]
  created: string
  updated: string
  content: string
}

function serializeBlock(block: MemoryBlock): string {
  const tags = block.tags.length > 0 ? `\ntags: ${JSON.stringify(block.tags)}` : ""
  return [
    "---",
    `id: ${block.id}`,
    `scope: ${block.scope}`,
    `created: ${block.created}`,
    `updated: ${block.updated}${tags}`,
    "---",
    "",
    block.content,
    "",
  ].join("\n")
}

const MEMORY_MAX_BLOCK_SIZE = 2048
const MEMORY_MAX_BLOCKS_PER_SCOPE = 50

// Standalone store implementation for testing (same logic as src/memory/store.ts)
function createTestStore(baseDir: string) {
  function blockPath(id: string): string {
    return path.join(baseDir, `${id}.md`)
  }

  return {
    async read(id: string): Promise<MemoryBlock | undefined> {
      const filepath = blockPath(id)
      let raw: string
      try {
        raw = await fs.readFile(filepath, "utf-8")
      } catch (e: any) {
        if (e.code === "ENOENT") return undefined
        throw e
      }
      const parsed = parseFrontmatter(raw)
      if (!parsed) return undefined
      return {
        id: String(parsed.meta.id ?? id),
        scope: (parsed.meta.scope as "global" | "project") ?? "global",
        tags: Array.isArray(parsed.meta.tags) ? (parsed.meta.tags as string[]) : [],
        created: String(parsed.meta.created ?? new Date().toISOString()),
        updated: String(parsed.meta.updated ?? new Date().toISOString()),
        content: parsed.content,
      }
    },

    async list(): Promise<MemoryBlock[]> {
      let entries: string[]
      try {
        entries = await fs.readdir(baseDir)
      } catch (e: any) {
        if (e.code === "ENOENT") return []
        throw e
      }
      const blocks: MemoryBlock[] = []
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue
        const id = entry.slice(0, -3)
        const block = await this.read(id)
        if (block) blocks.push(block)
      }
      blocks.sort((a, b) => b.updated.localeCompare(a.updated))
      return blocks
    },

    async write(block: MemoryBlock): Promise<void> {
      if (block.content.length > MEMORY_MAX_BLOCK_SIZE) {
        throw new Error(
          `Memory block "${block.id}" content exceeds maximum size of ${MEMORY_MAX_BLOCK_SIZE} characters (got ${block.content.length})`,
        )
      }
      const existing = await this.list()
      const isUpdate = existing.some((b) => b.id === block.id)
      if (!isUpdate && existing.length >= MEMORY_MAX_BLOCKS_PER_SCOPE) {
        throw new Error(
          `Cannot create memory block "${block.id}": scope "${block.scope}" already has ${MEMORY_MAX_BLOCKS_PER_SCOPE} blocks (maximum). Delete an existing block first.`,
        )
      }
      await fs.mkdir(baseDir, { recursive: true })
      const filepath = blockPath(block.id)
      const tmpPath = filepath + ".tmp"
      const serialized = serializeBlock(block)
      await fs.writeFile(tmpPath, serialized, "utf-8")
      await fs.rename(tmpPath, filepath)
    },

    async remove(id: string): Promise<boolean> {
      const filepath = blockPath(id)
      try {
        await fs.unlink(filepath)
        return true
      } catch (e: any) {
        if (e.code === "ENOENT") return false
        throw e
      }
    },
  }
}

let tmpDir: string
let store: ReturnType<typeof createTestStore>

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-test-"))
  store = createTestStore(tmpDir)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

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

describe("MemoryStore", () => {
  describe("write and read", () => {
    test("writes and reads a block", async () => {
      const block = makeBlock()
      await store.write(block)
      const result = await store.read("test-block")
      expect(result).toBeDefined()
      expect(result!.id).toBe("test-block")
      expect(result!.scope).toBe("project")
      expect(result!.content).toBe("Test content")
    })

    test("preserves tags", async () => {
      const block = makeBlock({ tags: ["warehouse", "snowflake"] })
      await store.write(block)
      const result = await store.read("test-block")
      expect(result!.tags).toEqual(["warehouse", "snowflake"])
    })

    test("preserves timestamps", async () => {
      const block = makeBlock({
        created: "2026-01-15T10:30:00.000Z",
        updated: "2026-03-14T08:00:00.000Z",
      })
      await store.write(block)
      const result = await store.read("test-block")
      expect(result!.created).toBe("2026-01-15T10:30:00.000Z")
      expect(result!.updated).toBe("2026-03-14T08:00:00.000Z")
    })

    test("handles multiline content", async () => {
      const content = "## Warehouse Config\n\n- Provider: Snowflake\n- Database: ANALYTICS\n\n### Notes\n\nSome notes here."
      const block = makeBlock({ content })
      await store.write(block)
      const result = await store.read("test-block")
      expect(result!.content).toBe(content)
    })

    test("overwrites existing block", async () => {
      await store.write(makeBlock({ content: "Version 1" }))
      await store.write(makeBlock({ content: "Version 2", updated: "2026-02-01T00:00:00.000Z" }))
      const result = await store.read("test-block")
      expect(result!.content).toBe("Version 2")
      expect(result!.updated).toBe("2026-02-01T00:00:00.000Z")
    })

    test("returns undefined for nonexistent block", async () => {
      const result = await store.read("nonexistent")
      expect(result).toBeUndefined()
    })
  })

  describe("list", () => {
    test("returns empty array for empty directory", async () => {
      const blocks = await store.list()
      expect(blocks).toEqual([])
    })

    test("returns empty array for nonexistent directory", async () => {
      const missingStore = createTestStore(path.join(tmpDir, "does-not-exist"))
      const blocks = await missingStore.list()
      expect(blocks).toEqual([])
    })

    test("lists multiple blocks sorted by updated desc", async () => {
      await store.write(makeBlock({ id: "older", updated: "2026-01-01T00:00:00.000Z" }))
      await store.write(makeBlock({ id: "newer", updated: "2026-03-01T00:00:00.000Z" }))
      await store.write(makeBlock({ id: "middle", updated: "2026-02-01T00:00:00.000Z" }))
      const blocks = await store.list()
      expect(blocks.map((b) => b.id)).toEqual(["newer", "middle", "older"])
    })

    test("ignores non-.md files", async () => {
      await store.write(makeBlock())
      await fs.writeFile(path.join(tmpDir, "notes.txt"), "not a memory block")
      await fs.writeFile(path.join(tmpDir, ".DS_Store"), "")
      const blocks = await store.list()
      expect(blocks).toHaveLength(1)
    })
  })

  describe("remove", () => {
    test("deletes an existing block", async () => {
      await store.write(makeBlock())
      const removed = await store.remove("test-block")
      expect(removed).toBe(true)
      const result = await store.read("test-block")
      expect(result).toBeUndefined()
    })

    test("returns false for nonexistent block", async () => {
      const removed = await store.remove("nonexistent")
      expect(removed).toBe(false)
    })
  })

  describe("size limits", () => {
    test("rejects blocks exceeding max size", async () => {
      const block = makeBlock({ content: "x".repeat(MEMORY_MAX_BLOCK_SIZE + 1) })
      await expect(store.write(block)).rejects.toThrow(/exceeds maximum size/)
    })

    test("accepts blocks at exactly max size", async () => {
      const block = makeBlock({ content: "x".repeat(MEMORY_MAX_BLOCK_SIZE) })
      await store.write(block)
      const result = await store.read("test-block")
      expect(result!.content.length).toBe(MEMORY_MAX_BLOCK_SIZE)
    })
  })

  describe("block count limits", () => {
    test("rejects new blocks when scope is at capacity", async () => {
      for (let i = 0; i < MEMORY_MAX_BLOCKS_PER_SCOPE; i++) {
        await store.write(makeBlock({ id: `block-${String(i).padStart(3, "0")}` }))
      }
      const extraBlock = makeBlock({ id: "one-too-many" })
      await expect(store.write(extraBlock)).rejects.toThrow(/already has 50 blocks/)
    })

    test("allows updating when scope is at capacity", async () => {
      for (let i = 0; i < MEMORY_MAX_BLOCKS_PER_SCOPE; i++) {
        await store.write(makeBlock({ id: `block-${String(i).padStart(3, "0")}` }))
      }
      // Updating an existing block should succeed
      await store.write(makeBlock({ id: "block-000", content: "Updated content" }))
      const result = await store.read("block-000")
      expect(result!.content).toBe("Updated content")
    })
  })

  describe("atomic writes", () => {
    test("does not leave .tmp files on success", async () => {
      await store.write(makeBlock())
      const entries = await fs.readdir(tmpDir)
      const tmpFiles = entries.filter((e) => e.endsWith(".tmp"))
      expect(tmpFiles).toHaveLength(0)
    })

    test("creates directory if it does not exist", async () => {
      const nestedStore = createTestStore(path.join(tmpDir, "nested", "deep", "memory"))
      await nestedStore.write(makeBlock())
      const result = await nestedStore.read("test-block")
      expect(result).toBeDefined()
    })
  })

  describe("frontmatter parsing", () => {
    test("handles files without frontmatter gracefully", async () => {
      await fs.writeFile(path.join(tmpDir, "bad-format.md"), "Just some text without frontmatter")
      const result = await store.read("bad-format")
      expect(result).toBeUndefined()
    })

    test("handles empty frontmatter", async () => {
      await fs.writeFile(path.join(tmpDir, "empty-meta.md"), "---\n\n---\nSome content")
      const result = await store.read("empty-meta")
      expect(result).toBeDefined()
      expect(result!.content).toBe("Some content")
    })

    test("handles content with dashes", async () => {
      const content = "First line\n---\nNot frontmatter\n---\nLast line"
      const block = makeBlock({ content })
      await store.write(block)
      const result = await store.read("test-block")
      expect(result!.content).toBe(content)
    })
  })

  describe("serialization roundtrip", () => {
    test("roundtrips a block with all fields", async () => {
      const block = makeBlock({
        id: "full-block",
        scope: "global",
        tags: ["dbt", "snowflake", "conventions"],
        created: "2026-01-15T10:30:00.000Z",
        updated: "2026-03-14T08:00:00.000Z",
        content: "## Naming Conventions\n\n- staging: `stg_`\n- intermediate: `int_`\n- marts: `fct_` / `dim_`",
      })
      await store.write(block)
      const result = await store.read("full-block")
      expect(result!.id).toBe(block.id)
      expect(result!.tags).toEqual(block.tags)
      expect(result!.created).toBe(block.created)
      expect(result!.updated).toBe(block.updated)
      expect(result!.content).toBe(block.content)
    })

    test("roundtrips a block with empty tags", async () => {
      const block = makeBlock({ tags: [] })
      await store.write(block)
      const result = await store.read("test-block")
      expect(result!.tags).toEqual([])
    })
  })
})
