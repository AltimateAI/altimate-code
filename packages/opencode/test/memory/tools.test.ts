import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

// Test tool parameter validation and output formatting
// These tests verify the Zod schemas and tool response structures
// without requiring the full OpenCode runtime.

import z from "zod"

const MEMORY_MAX_BLOCK_SIZE = 2048

// Reproduce the Zod schemas from the tool definitions
const MemoryReadParams = z.object({
  scope: z.enum(["global", "project", "all"]).optional().default("all"),
  tags: z.array(z.string()).optional().default([]),
  id: z.string().optional(),
})

const MemoryWriteParams = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  scope: z.enum(["global", "project"]),
  content: z.string().min(1).max(MEMORY_MAX_BLOCK_SIZE),
  tags: z.array(z.string().max(64)).max(10).optional().default([]),
})

const MemoryDeleteParams = z.object({
  id: z.string().min(1),
  scope: z.enum(["global", "project"]),
})

const MemoryBlockIdRegex = /^[a-z0-9][a-z0-9_-]*$/

describe("Memory Tool Schemas", () => {
  describe("MemoryReadParams", () => {
    test("accepts minimal params", () => {
      const result = MemoryReadParams.parse({})
      expect(result.scope).toBe("all")
      expect(result.tags).toEqual([])
      expect(result.id).toBeUndefined()
    })

    test("accepts scope filter", () => {
      const result = MemoryReadParams.parse({ scope: "project" })
      expect(result.scope).toBe("project")
    })

    test("accepts tag filter", () => {
      const result = MemoryReadParams.parse({ tags: ["dbt", "warehouse"] })
      expect(result.tags).toEqual(["dbt", "warehouse"])
    })

    test("accepts id lookup", () => {
      const result = MemoryReadParams.parse({ id: "warehouse-config" })
      expect(result.id).toBe("warehouse-config")
    })

    test("rejects invalid scope", () => {
      expect(() => MemoryReadParams.parse({ scope: "invalid" })).toThrow()
    })
  })

  describe("MemoryWriteParams", () => {
    test("accepts valid params", () => {
      const result = MemoryWriteParams.parse({
        id: "warehouse-config",
        scope: "project",
        content: "Snowflake warehouse",
      })
      expect(result.id).toBe("warehouse-config")
      expect(result.scope).toBe("project")
      expect(result.content).toBe("Snowflake warehouse")
      expect(result.tags).toEqual([])
    })

    test("accepts params with tags", () => {
      const result = MemoryWriteParams.parse({
        id: "naming-conventions",
        scope: "global",
        content: "Use stg_ prefix",
        tags: ["dbt", "conventions"],
      })
      expect(result.tags).toEqual(["dbt", "conventions"])
    })

    test("rejects empty id", () => {
      expect(() =>
        MemoryWriteParams.parse({ id: "", scope: "project", content: "test" }),
      ).toThrow()
    })

    test("rejects id with uppercase", () => {
      expect(() =>
        MemoryWriteParams.parse({ id: "MyBlock", scope: "project", content: "test" }),
      ).toThrow()
    })

    test("rejects id with spaces", () => {
      expect(() =>
        MemoryWriteParams.parse({ id: "my block", scope: "project", content: "test" }),
      ).toThrow()
    })

    test("rejects id starting with hyphen", () => {
      expect(() =>
        MemoryWriteParams.parse({ id: "-invalid", scope: "project", content: "test" }),
      ).toThrow()
    })

    test("accepts id with underscores and hyphens", () => {
      const result = MemoryWriteParams.parse({
        id: "my_warehouse-config-2",
        scope: "project",
        content: "test",
      })
      expect(result.id).toBe("my_warehouse-config-2")
    })

    test("rejects content exceeding max size", () => {
      expect(() =>
        MemoryWriteParams.parse({
          id: "big",
          scope: "project",
          content: "x".repeat(MEMORY_MAX_BLOCK_SIZE + 1),
        }),
      ).toThrow()
    })

    test("rejects empty content", () => {
      expect(() =>
        MemoryWriteParams.parse({ id: "empty", scope: "project", content: "" }),
      ).toThrow()
    })

    test("rejects more than 10 tags", () => {
      expect(() =>
        MemoryWriteParams.parse({
          id: "many-tags",
          scope: "project",
          content: "test",
          tags: Array.from({ length: 11 }, (_, i) => `tag-${i}`),
        }),
      ).toThrow()
    })

    test("rejects tags longer than 64 chars", () => {
      expect(() =>
        MemoryWriteParams.parse({
          id: "long-tag",
          scope: "project",
          content: "test",
          tags: ["x".repeat(65)],
        }),
      ).toThrow()
    })

    test("rejects id longer than 128 chars", () => {
      expect(() =>
        MemoryWriteParams.parse({
          id: "a".repeat(129),
          scope: "project",
          content: "test",
        }),
      ).toThrow()
    })
  })

  describe("MemoryDeleteParams", () => {
    test("accepts valid params", () => {
      const result = MemoryDeleteParams.parse({ id: "old-block", scope: "global" })
      expect(result.id).toBe("old-block")
      expect(result.scope).toBe("global")
    })

    test("rejects empty id", () => {
      expect(() => MemoryDeleteParams.parse({ id: "", scope: "project" })).toThrow()
    })

    test("rejects invalid scope", () => {
      expect(() => MemoryDeleteParams.parse({ id: "block", scope: "all" })).toThrow()
    })
  })
})

describe("Memory Block ID validation", () => {
  const validIds = [
    "warehouse-config",
    "naming-conventions",
    "dbt-patterns",
    "my_block",
    "block123",
    "a",
    "0-config",
  ]

  const invalidIds = [
    "-invalid",
    "_invalid",
    "Invalid",
    "UPPER",
    "has space",
    "has.dot",
    "has/slash",
    "",
  ]

  for (const id of validIds) {
    test(`accepts valid id: "${id}"`, () => {
      expect(MemoryBlockIdRegex.test(id)).toBe(true)
    })
  }

  for (const id of invalidIds) {
    test(`rejects invalid id: "${id}"`, () => {
      expect(MemoryBlockIdRegex.test(id)).toBe(false)
    })
  }
})

describe("Memory Tool Integration", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-tools-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // Simulate the full write → read → delete flow using filesystem operations
  test("full lifecycle: write, read, update, delete", async () => {
    const memDir = path.join(tmpDir, "memory")
    await fs.mkdir(memDir, { recursive: true })

    // 1. Write a block
    const block = {
      id: "warehouse-config",
      scope: "project" as const,
      tags: ["snowflake", "warehouse"],
      created: "2026-03-14T10:00:00.000Z",
      updated: "2026-03-14T10:00:00.000Z",
      content: "## Warehouse\n\n- Provider: Snowflake\n- Warehouse: ANALYTICS_WH",
    }

    const serialized =
      `---\nid: ${block.id}\nscope: ${block.scope}\ncreated: ${block.created}\nupdated: ${block.updated}\ntags: ${JSON.stringify(block.tags)}\n---\n\n${block.content}\n`
    await fs.writeFile(path.join(memDir, `${block.id}.md`), serialized)

    // 2. Verify it exists
    const files = await fs.readdir(memDir)
    expect(files).toContain("warehouse-config.md")

    // 3. Read and verify content
    const raw = await fs.readFile(path.join(memDir, "warehouse-config.md"), "utf-8")
    expect(raw).toContain("id: warehouse-config")
    expect(raw).toContain("scope: project")
    expect(raw).toContain('tags: ["snowflake","warehouse"]')
    expect(raw).toContain("Provider: Snowflake")

    // 4. Update the block
    const updated = serialized.replace("ANALYTICS_WH", "COMPUTE_WH").replace(
      "2026-03-14T10:00:00.000Z\ntags",
      "2026-03-14T12:00:00.000Z\ntags",
    )
    await fs.writeFile(path.join(memDir, `${block.id}.md`), updated)

    const rawUpdated = await fs.readFile(path.join(memDir, "warehouse-config.md"), "utf-8")
    expect(rawUpdated).toContain("COMPUTE_WH")

    // 5. Delete
    await fs.unlink(path.join(memDir, "warehouse-config.md"))
    const filesAfterDelete = await fs.readdir(memDir)
    expect(filesAfterDelete).not.toContain("warehouse-config.md")
  })

  test("concurrent writes to different blocks", async () => {
    const memDir = path.join(tmpDir, "memory")
    await fs.mkdir(memDir, { recursive: true })

    // Write multiple blocks concurrently
    const writes = Array.from({ length: 10 }, (_, i) => {
      const content = `---\nid: block-${i}\nscope: project\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nContent ${i}\n`
      return fs.writeFile(path.join(memDir, `block-${i}.md`), content)
    })

    await Promise.all(writes)

    const files = await fs.readdir(memDir)
    expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(10)
  })

  test("handles special characters in content", async () => {
    const memDir = path.join(tmpDir, "memory")
    await fs.mkdir(memDir, { recursive: true })

    const content = "SELECT * FROM \"schema\".table WHERE col = 'value' AND price > $100 & active = true"
    const serialized = `---\nid: sql-notes\nscope: project\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\n${content}\n`
    await fs.writeFile(path.join(memDir, "sql-notes.md"), serialized)

    const raw = await fs.readFile(path.join(memDir, "sql-notes.md"), "utf-8")
    expect(raw).toContain("SELECT * FROM")
    expect(raw).toContain("$100")
  })
})
