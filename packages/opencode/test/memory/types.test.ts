import { describe, test, expect } from "bun:test"
import z from "zod"

// Test the MemoryBlockSchema validation directly
const MemoryBlockSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message: "ID must be lowercase alphanumeric with hyphens/underscores, starting with alphanumeric",
  }),
  scope: z.enum(["global", "project"]),
  tags: z.array(z.string().max(64)).max(10).default([]),
  created: z.string().datetime(),
  updated: z.string().datetime(),
  content: z.string(),
})

describe("MemoryBlockSchema", () => {
  const validBlock = {
    id: "warehouse-config",
    scope: "project",
    tags: ["snowflake"],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    content: "Test content",
  }

  test("accepts valid block", () => {
    const result = MemoryBlockSchema.parse(validBlock)
    expect(result.id).toBe("warehouse-config")
  })

  test("defaults tags to empty array", () => {
    const { tags, ...rest } = validBlock
    const result = MemoryBlockSchema.parse(rest)
    expect(result.tags).toEqual([])
  })

  describe("id validation", () => {
    test("rejects uppercase", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "MyBlock" })).toThrow()
    })

    test("rejects spaces", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "my block" })).toThrow()
    })

    test("rejects starting with hyphen", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "-bad" })).toThrow()
    })

    test("rejects starting with underscore", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "_bad" })).toThrow()
    })

    test("rejects empty string", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "" })).toThrow()
    })

    test("rejects dots", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "my.block" })).toThrow()
    })

    test("rejects slashes", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "my/block" })).toThrow()
    })

    test("accepts hyphens and underscores", () => {
      const result = MemoryBlockSchema.parse({ ...validBlock, id: "my-block_2" })
      expect(result.id).toBe("my-block_2")
    })

    test("accepts single character", () => {
      const result = MemoryBlockSchema.parse({ ...validBlock, id: "a" })
      expect(result.id).toBe("a")
    })

    test("accepts numbers at start", () => {
      const result = MemoryBlockSchema.parse({ ...validBlock, id: "0config" })
      expect(result.id).toBe("0config")
    })

    test("rejects id over 128 chars", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "a".repeat(129) })).toThrow()
    })
  })

  describe("scope validation", () => {
    test("accepts 'global'", () => {
      const result = MemoryBlockSchema.parse({ ...validBlock, scope: "global" })
      expect(result.scope).toBe("global")
    })

    test("accepts 'project'", () => {
      const result = MemoryBlockSchema.parse({ ...validBlock, scope: "project" })
      expect(result.scope).toBe("project")
    })

    test("rejects other values", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, scope: "session" })).toThrow()
    })
  })

  describe("tags validation", () => {
    test("accepts up to 10 tags", () => {
      const tags = Array.from({ length: 10 }, (_, i) => `tag-${i}`)
      const result = MemoryBlockSchema.parse({ ...validBlock, tags })
      expect(result.tags).toHaveLength(10)
    })

    test("rejects more than 10 tags", () => {
      const tags = Array.from({ length: 11 }, (_, i) => `tag-${i}`)
      expect(() => MemoryBlockSchema.parse({ ...validBlock, tags })).toThrow()
    })

    test("rejects tags over 64 chars", () => {
      expect(() =>
        MemoryBlockSchema.parse({ ...validBlock, tags: ["x".repeat(65)] }),
      ).toThrow()
    })
  })

  describe("datetime validation", () => {
    test("accepts ISO datetime", () => {
      const result = MemoryBlockSchema.parse(validBlock)
      expect(result.created).toBe("2026-01-01T00:00:00.000Z")
    })

    test("rejects invalid datetime", () => {
      expect(() =>
        MemoryBlockSchema.parse({ ...validBlock, created: "not-a-date" }),
      ).toThrow()
    })

    test("rejects date without time", () => {
      expect(() =>
        MemoryBlockSchema.parse({ ...validBlock, created: "2026-01-01" }),
      ).toThrow()
    })
  })
})
