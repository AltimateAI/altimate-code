import { describe, test, expect } from "bun:test"
import z from "zod"

// Mirror the schemas from src/memory/types.ts for standalone testing
const CitationSchema = z.object({
  file: z.string().min(1).max(512),
  line: z.number().int().positive().optional(),
  note: z.string().max(256).optional(),
})

// Safe ID regex: segments separated by '/' or '.', no '..' or empty segments
const MEMORY_ID_SEGMENT = /[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?/
const MEMORY_ID_REGEX = new RegExp(
  `^${MEMORY_ID_SEGMENT.source}(?:\\.${MEMORY_ID_SEGMENT.source})*(?:/${MEMORY_ID_SEGMENT.source}(?:\\.${MEMORY_ID_SEGMENT.source})*)*$`,
)

const MemoryBlockSchema = z.object({
  id: z.string().min(1).max(256).regex(MEMORY_ID_REGEX, {
    message: "ID must be lowercase alphanumeric segments separated by '/' or '.', each starting/ending with alphanumeric",
  }),
  scope: z.enum(["global", "project"]),
  tags: z.array(z.string().max(64)).max(10).default([]),
  created: z.string().datetime(),
  updated: z.string().datetime(),
  expires: z.string().datetime().optional(),
  citations: z.array(CitationSchema).max(10).optional(),
  content: z.string(),
})

const MEMORY_MAX_BLOCK_SIZE = 2048
const MEMORY_MAX_BLOCKS_PER_SCOPE = 50
const MEMORY_MAX_CITATIONS = 10
const MEMORY_DEFAULT_INJECTION_BUDGET = 8000

describe("CitationSchema", () => {
  test("accepts valid citation with all fields", () => {
    const result = CitationSchema.parse({ file: "src/main.ts", line: 42, note: "Config definition" })
    expect(result.file).toBe("src/main.ts")
    expect(result.line).toBe(42)
    expect(result.note).toBe("Config definition")
  })

  test("accepts citation with only file", () => {
    const result = CitationSchema.parse({ file: "dbt_project.yml" })
    expect(result.file).toBe("dbt_project.yml")
    expect(result.line).toBeUndefined()
    expect(result.note).toBeUndefined()
  })

  test("rejects empty file", () => {
    expect(() => CitationSchema.parse({ file: "" })).toThrow()
  })

  test("rejects file over 512 chars", () => {
    expect(() => CitationSchema.parse({ file: "x".repeat(513) })).toThrow()
  })

  test("rejects non-positive line number", () => {
    expect(() => CitationSchema.parse({ file: "a.ts", line: 0 })).toThrow()
    expect(() => CitationSchema.parse({ file: "a.ts", line: -1 })).toThrow()
  })

  test("rejects non-integer line number", () => {
    expect(() => CitationSchema.parse({ file: "a.ts", line: 1.5 })).toThrow()
  })

  test("rejects note over 256 chars", () => {
    expect(() => CitationSchema.parse({ file: "a.ts", note: "x".repeat(257) })).toThrow()
  })
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

  test("accepts block with expires field", () => {
    const result = MemoryBlockSchema.parse({ ...validBlock, expires: "2026-06-01T00:00:00.000Z" })
    expect(result.expires).toBe("2026-06-01T00:00:00.000Z")
  })

  test("expires is optional (undefined by default)", () => {
    const result = MemoryBlockSchema.parse(validBlock)
    expect(result.expires).toBeUndefined()
  })

  test("rejects invalid expires datetime", () => {
    expect(() => MemoryBlockSchema.parse({ ...validBlock, expires: "not-a-date" })).toThrow()
  })

  test("accepts block with citations", () => {
    const citations = [{ file: "src/config.ts", line: 10, note: "Warehouse constant" }]
    const result = MemoryBlockSchema.parse({ ...validBlock, citations })
    expect(result.citations).toHaveLength(1)
    expect(result.citations![0].file).toBe("src/config.ts")
  })

  test("citations is optional (undefined by default)", () => {
    const result = MemoryBlockSchema.parse(validBlock)
    expect(result.citations).toBeUndefined()
  })

  test("rejects more than 10 citations", () => {
    const citations = Array.from({ length: 11 }, (_, i) => ({ file: `file${i}.ts` }))
    expect(() => MemoryBlockSchema.parse({ ...validBlock, citations })).toThrow()
  })

  test("accepts up to 10 citations", () => {
    const citations = Array.from({ length: 10 }, (_, i) => ({ file: `file${i}.ts` }))
    const result = MemoryBlockSchema.parse({ ...validBlock, citations })
    expect(result.citations).toHaveLength(10)
  })

  describe("id validation — hierarchical IDs", () => {
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

    test("accepts dots in id (hierarchical)", () => {
      const result = MemoryBlockSchema.parse({ ...validBlock, id: "warehouse.config" })
      expect(result.id).toBe("warehouse.config")
    })

    test("accepts slashes in id (hierarchical namespace)", () => {
      const result = MemoryBlockSchema.parse({ ...validBlock, id: "warehouse/snowflake" })
      expect(result.id).toBe("warehouse/snowflake")
    })

    test("accepts deep nested hierarchical id", () => {
      const result = MemoryBlockSchema.parse({ ...validBlock, id: "team/data/warehouse/snowflake-config" })
      expect(result.id).toBe("team/data/warehouse/snowflake-config")
    })

    test("accepts dots and slashes combined", () => {
      const result = MemoryBlockSchema.parse({ ...validBlock, id: "v1.0/warehouse/config" })
      expect(result.id).toBe("v1.0/warehouse/config")
    })

    test("rejects id ending with slash", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "warehouse/" })).toThrow()
    })

    test("rejects id ending with dot", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "warehouse." })).toThrow()
    })

    test("rejects id ending with hyphen", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "warehouse-" })).toThrow()
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

    test("rejects id over 256 chars", () => {
      expect(() => MemoryBlockSchema.parse({ ...validBlock, id: "a".repeat(257) })).toThrow()
    })

    test("accepts id at exactly 256 chars", () => {
      // must end with alphanumeric
      const id = "a".repeat(256)
      const result = MemoryBlockSchema.parse({ ...validBlock, id })
      expect(result.id).toBe(id)
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

describe("Constants", () => {
  test("MEMORY_MAX_BLOCK_SIZE is 2048", () => {
    expect(MEMORY_MAX_BLOCK_SIZE).toBe(2048)
  })

  test("MEMORY_MAX_BLOCKS_PER_SCOPE is 50", () => {
    expect(MEMORY_MAX_BLOCKS_PER_SCOPE).toBe(50)
  })

  test("MEMORY_MAX_CITATIONS is 10", () => {
    expect(MEMORY_MAX_CITATIONS).toBe(10)
  })

  test("MEMORY_DEFAULT_INJECTION_BUDGET is 8000", () => {
    expect(MEMORY_DEFAULT_INJECTION_BUDGET).toBe(8000)
  })
})
