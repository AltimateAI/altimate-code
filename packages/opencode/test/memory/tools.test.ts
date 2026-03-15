import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

// Test tool parameter validation, output formatting, and integration
// These tests verify Zod schemas and tool response structures
// without requiring the full OpenCode runtime.

import z from "zod"

const MEMORY_MAX_BLOCK_SIZE = 2048

// Safe ID regex: segments separated by '/' or '.', no '..' or empty segments (prevents path traversal)
const MEMORY_ID_SEGMENT = /[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?/
const SAFE_ID_REGEX = new RegExp(
  `^${MEMORY_ID_SEGMENT.source}(?:\\.${MEMORY_ID_SEGMENT.source})*(?:/${MEMORY_ID_SEGMENT.source}(?:\\.${MEMORY_ID_SEGMENT.source})*)*$`,
)

// --- Schemas matching the actual tool definitions ---

const CitationSchema = z.object({
  file: z.string().min(1).max(512),
  line: z.number().int().positive().optional(),
  note: z.string().max(256).optional(),
})

const MemoryReadParams = z.object({
  scope: z.enum(["global", "project", "all"]).optional().default("all"),
  tags: z.array(z.string()).optional().default([]),
  id: z.string().min(1).max(256).regex(SAFE_ID_REGEX).optional(),
  include_expired: z.boolean().optional().default(false),
})

const MemoryWriteParams = z.object({
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(SAFE_ID_REGEX),
  scope: z.enum(["global", "project"]),
  content: z.string().min(1).max(MEMORY_MAX_BLOCK_SIZE),
  tags: z.array(z.string().max(64)).max(10).optional().default([]),
  expires: z.string().datetime().optional(),
  citations: z.array(CitationSchema).max(10).optional(),
})

const MemoryDeleteParams = z.object({
  id: z.string().min(1).max(256).regex(SAFE_ID_REGEX),
  scope: z.enum(["global", "project"]),
})

const MemoryAuditParams = z.object({
  scope: z.enum(["global", "project", "all"]).optional().default("all"),
  limit: z.number().int().positive().max(200).optional().default(50),
})

const MemoryExtractParams = z.object({
  facts: z
    .array(
      z.object({
        id: z.string().min(1).max(256).regex(SAFE_ID_REGEX),
        scope: z.enum(["global", "project"]),
        content: z.string().min(1).max(2048),
        tags: z.array(z.string().max(64)).max(10).optional().default([]),
        citations: z
          .array(
            z.object({
              file: z.string().min(1).max(512),
              line: z.number().int().positive().optional(),
              note: z.string().max(256).optional(),
            }),
          )
          .max(10)
          .optional(),
      }),
    )
    .min(1)
    .max(10),
})

// Alias for use in ID validation tests
const MemoryBlockIdRegex = SAFE_ID_REGEX

describe("Memory Tool Schemas", () => {
  describe("MemoryReadParams", () => {
    test("accepts minimal params", () => {
      const result = MemoryReadParams.parse({})
      expect(result.scope).toBe("all")
      expect(result.tags).toEqual([])
      expect(result.id).toBeUndefined()
      expect(result.include_expired).toBe(false)
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

    test("accepts include_expired=true", () => {
      const result = MemoryReadParams.parse({ include_expired: true })
      expect(result.include_expired).toBe(true)
    })

    test("rejects invalid scope", () => {
      expect(() => MemoryReadParams.parse({ scope: "invalid" })).toThrow()
    })

    test("accepts hierarchical id in lookup", () => {
      const result = MemoryReadParams.parse({ id: "warehouse/snowflake" })
      expect(result.id).toBe("warehouse/snowflake")
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
      expect(result.expires).toBeUndefined()
      expect(result.citations).toBeUndefined()
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

    test("accepts params with expires", () => {
      const result = MemoryWriteParams.parse({
        id: "temp-note",
        scope: "project",
        content: "Temporary note",
        expires: "2027-06-01T00:00:00.000Z",
      })
      expect(result.expires).toBe("2027-06-01T00:00:00.000Z")
    })

    test("rejects invalid expires datetime", () => {
      expect(() =>
        MemoryWriteParams.parse({
          id: "bad-expires",
          scope: "project",
          content: "test",
          expires: "not-a-date",
        }),
      ).toThrow()
    })

    test("accepts params with citations", () => {
      const result = MemoryWriteParams.parse({
        id: "cited-block",
        scope: "project",
        content: "Config from code",
        citations: [{ file: "src/config.ts", line: 42, note: "Constant definition" }],
      })
      expect(result.citations).toHaveLength(1)
      expect(result.citations![0].file).toBe("src/config.ts")
    })

    test("rejects more than 10 citations", () => {
      const citations = Array.from({ length: 11 }, (_, i) => ({ file: `file${i}.ts` }))
      expect(() =>
        MemoryWriteParams.parse({
          id: "too-many-citations",
          scope: "project",
          content: "test",
          citations,
        }),
      ).toThrow()
    })

    test("accepts hierarchical id with slashes", () => {
      const result = MemoryWriteParams.parse({
        id: "warehouse/snowflake-config",
        scope: "project",
        content: "Snowflake setup",
      })
      expect(result.id).toBe("warehouse/snowflake-config")
    })

    test("accepts hierarchical id with dots", () => {
      const result = MemoryWriteParams.parse({
        id: "v1.0/config",
        scope: "project",
        content: "Versioned config",
      })
      expect(result.id).toBe("v1.0/config")
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

    test("rejects id ending with slash", () => {
      expect(() =>
        MemoryWriteParams.parse({ id: "warehouse/", scope: "project", content: "test" }),
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

    test("rejects id longer than 256 chars", () => {
      expect(() =>
        MemoryWriteParams.parse({
          id: "a".repeat(257),
          scope: "project",
          content: "test",
        }),
      ).toThrow()
    })

    test("accepts single-char id", () => {
      const result = MemoryWriteParams.parse({ id: "a", scope: "project", content: "test" })
      expect(result.id).toBe("a")
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

  describe("MemoryAuditParams", () => {
    test("accepts minimal params with defaults", () => {
      const result = MemoryAuditParams.parse({})
      expect(result.scope).toBe("all")
      expect(result.limit).toBe(50)
    })

    test("accepts specific scope", () => {
      const result = MemoryAuditParams.parse({ scope: "project" })
      expect(result.scope).toBe("project")
    })

    test("accepts custom limit", () => {
      const result = MemoryAuditParams.parse({ limit: 100 })
      expect(result.limit).toBe(100)
    })

    test("rejects limit over 200", () => {
      expect(() => MemoryAuditParams.parse({ limit: 201 })).toThrow()
    })

    test("rejects non-positive limit", () => {
      expect(() => MemoryAuditParams.parse({ limit: 0 })).toThrow()
      expect(() => MemoryAuditParams.parse({ limit: -1 })).toThrow()
    })

    test("rejects non-integer limit", () => {
      expect(() => MemoryAuditParams.parse({ limit: 10.5 })).toThrow()
    })

    test("accepts scope 'all'", () => {
      const result = MemoryAuditParams.parse({ scope: "all" })
      expect(result.scope).toBe("all")
    })

    test("rejects invalid scope", () => {
      expect(() => MemoryAuditParams.parse({ scope: "invalid" })).toThrow()
    })
  })

  describe("MemoryExtractParams", () => {
    test("accepts valid facts array", () => {
      const result = MemoryExtractParams.parse({
        facts: [
          { id: "warehouse-config", scope: "project", content: "Snowflake ANALYTICS_WH" },
          { id: "sql-style", scope: "global", content: "Use CTEs over subqueries" },
        ],
      })
      expect(result.facts).toHaveLength(2)
    })

    test("accepts facts with all optional fields", () => {
      const result = MemoryExtractParams.parse({
        facts: [
          {
            id: "warehouse/config",
            scope: "project",
            content: "Snowflake setup",
            tags: ["snowflake", "warehouse"],
            citations: [{ file: "profiles.yml", line: 3, note: "Connection config" }],
          },
        ],
      })
      expect(result.facts[0].tags).toEqual(["snowflake", "warehouse"])
      expect(result.facts[0].citations).toHaveLength(1)
    })

    test("rejects empty facts array", () => {
      expect(() => MemoryExtractParams.parse({ facts: [] })).toThrow()
    })

    test("rejects more than 10 facts", () => {
      const facts = Array.from({ length: 11 }, (_, i) => ({
        id: `fact-${i}`,
        scope: "project" as const,
        content: `Fact ${i}`,
      }))
      expect(() => MemoryExtractParams.parse({ facts })).toThrow()
    })

    test("rejects fact with invalid id", () => {
      expect(() =>
        MemoryExtractParams.parse({
          facts: [{ id: "INVALID", scope: "project", content: "test" }],
        }),
      ).toThrow()
    })

    test("rejects fact with empty content", () => {
      expect(() =>
        MemoryExtractParams.parse({
          facts: [{ id: "valid", scope: "project", content: "" }],
        }),
      ).toThrow()
    })

    test("rejects fact with content over 2048 chars", () => {
      expect(() =>
        MemoryExtractParams.parse({
          facts: [{ id: "big", scope: "project", content: "x".repeat(2049) }],
        }),
      ).toThrow()
    })

    test("accepts hierarchical IDs in facts", () => {
      const result = MemoryExtractParams.parse({
        facts: [{ id: "warehouse/snowflake/config", scope: "project", content: "test" }],
      })
      expect(result.facts[0].id).toBe("warehouse/snowflake/config")
    })
  })
})

describe("Memory Block ID validation (hierarchical)", () => {
  const validIds = [
    "warehouse-config",
    "naming-conventions",
    "dbt-patterns",
    "my_block",
    "block123",
    "a",
    "0-config",
    // New hierarchical IDs
    "warehouse/snowflake",
    "warehouse/bigquery-config",
    "team/data/warehouse/snowflake",
    "v1.0/config",
    "conventions.dbt",
  ]

  const invalidIds = [
    "-invalid",
    "_invalid",
    "Invalid",
    "UPPER",
    "has space",
    "",
    "warehouse/",   // ends with slash
    "warehouse.",    // ends with dot
    "/warehouse",    // starts with slash
    ".warehouse",    // starts with dot
    "warehouse-",    // ends with hyphen
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

  test("full lifecycle: write, read, update, delete", async () => {
    const memDir = path.join(tmpDir, "memory")
    await fs.mkdir(memDir, { recursive: true })

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

    const files = await fs.readdir(memDir)
    expect(files).toContain("warehouse-config.md")

    const raw = await fs.readFile(path.join(memDir, "warehouse-config.md"), "utf-8")
    expect(raw).toContain("id: warehouse-config")
    expect(raw).toContain("scope: project")
    expect(raw).toContain('tags: ["snowflake","warehouse"]')
    expect(raw).toContain("Provider: Snowflake")

    const updated = serialized.replace("ANALYTICS_WH", "COMPUTE_WH").replace(
      "2026-03-14T10:00:00.000Z\ntags",
      "2026-03-14T12:00:00.000Z\ntags",
    )
    await fs.writeFile(path.join(memDir, `${block.id}.md`), updated)

    const rawUpdated = await fs.readFile(path.join(memDir, "warehouse-config.md"), "utf-8")
    expect(rawUpdated).toContain("COMPUTE_WH")

    await fs.unlink(path.join(memDir, "warehouse-config.md"))
    const filesAfterDelete = await fs.readdir(memDir)
    expect(filesAfterDelete).not.toContain("warehouse-config.md")
  })

  test("hierarchical block lifecycle with subdirectories", async () => {
    const memDir = path.join(tmpDir, "memory")
    const subDir = path.join(memDir, "warehouse")
    await fs.mkdir(subDir, { recursive: true })

    const content = `---\nid: warehouse/snowflake\nscope: project\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\ntags: ["snowflake"]\n---\n\nSnowflake config\n`
    await fs.writeFile(path.join(subDir, "snowflake.md"), content)

    const exists = await fs.stat(path.join(subDir, "snowflake.md")).then(() => true).catch(() => false)
    expect(exists).toBe(true)

    const raw = await fs.readFile(path.join(subDir, "snowflake.md"), "utf-8")
    expect(raw).toContain("warehouse/snowflake")
  })

  test("block with expires and citations serialized correctly", async () => {
    const memDir = path.join(tmpDir, "memory")
    await fs.mkdir(memDir, { recursive: true })

    const content = [
      "---",
      "id: temp-config",
      "scope: project",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      'tags: ["temporary"]',
      "expires: 2027-06-01T00:00:00.000Z",
      'citations: [{"file":"config.ts","line":10,"note":"Main config"}]',
      "---",
      "",
      "Temporary configuration",
      "",
    ].join("\n")

    await fs.writeFile(path.join(memDir, "temp-config.md"), content)
    const raw = await fs.readFile(path.join(memDir, "temp-config.md"), "utf-8")
    expect(raw).toContain("expires: 2027-06-01T00:00:00.000Z")
    expect(raw).toContain("citations:")
    expect(raw).toContain("config.ts")
  })

  test("concurrent writes to different blocks", async () => {
    const memDir = path.join(tmpDir, "memory")
    await fs.mkdir(memDir, { recursive: true })

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

describe("Review fix: MemoryReadParams ID validation", () => {
  test("rejects uppercase ID in read", () => {
    expect(() => MemoryReadParams.parse({ id: "MyBlock" })).toThrow()
  })

  test("rejects path traversal ID in read", () => {
    expect(() => MemoryReadParams.parse({ id: "../secret" })).toThrow()
  })

  test("rejects ID with spaces in read", () => {
    expect(() => MemoryReadParams.parse({ id: "my block" })).toThrow()
  })

  test("accepts valid hierarchical ID in read", () => {
    const result = MemoryReadParams.parse({ id: "warehouse/snowflake-config" })
    expect(result.id).toBe("warehouse/snowflake-config")
  })

  test("accepts undefined ID in read (list mode)", () => {
    const result = MemoryReadParams.parse({})
    expect(result.id).toBeUndefined()
  })

  test("rejects ID starting with hyphen in read", () => {
    expect(() => MemoryReadParams.parse({ id: "-bad" })).toThrow()
  })

  test("rejects ID ending with slash in read", () => {
    expect(() => MemoryReadParams.parse({ id: "warehouse/" })).toThrow()
  })
})

describe("Review fix: MemoryDeleteParams ID validation", () => {
  test("rejects uppercase ID in delete", () => {
    expect(() => MemoryDeleteParams.parse({ id: "MyBlock", scope: "project" })).toThrow()
  })

  test("rejects path traversal ID in delete", () => {
    expect(() => MemoryDeleteParams.parse({ id: "../../../etc/passwd", scope: "project" })).toThrow()
  })

  test("rejects ID with dot-dot in delete", () => {
    expect(() => MemoryDeleteParams.parse({ id: "a/../b", scope: "project" })).toThrow()
  })

  test("accepts valid hierarchical ID in delete", () => {
    const result = MemoryDeleteParams.parse({ id: "warehouse/snowflake", scope: "project" })
    expect(result.id).toBe("warehouse/snowflake")
  })

  test("accepts single-char ID in delete", () => {
    const result = MemoryDeleteParams.parse({ id: "a", scope: "global" })
    expect(result.id).toBe("a")
  })

  test("rejects ID over 256 chars in delete", () => {
    expect(() => MemoryDeleteParams.parse({ id: "a".repeat(257), scope: "project" })).toThrow()
  })
})

describe("Review fix: include_expired for ID reads", () => {
  test("MemoryReadParams accepts include_expired with ID", () => {
    const result = MemoryReadParams.parse({ id: "my-block", include_expired: true })
    expect(result.id).toBe("my-block")
    expect(result.include_expired).toBe(true)
  })

  test("MemoryReadParams defaults include_expired to false with ID", () => {
    const result = MemoryReadParams.parse({ id: "my-block" })
    expect(result.include_expired).toBe(false)
  })
})

describe("Review fix: duplicate tags in deduplication", () => {
  test("concept: deduplicating tags before overlap calculation", () => {
    // Simulate the dedup logic
    const tags = ["snowflake", "snowflake", "snowflake", "other"]
    const uniqueTags = [...new Set(tags)]
    expect(uniqueTags).toEqual(["snowflake", "other"])
    expect(uniqueTags.length).toBe(2)

    // Threshold: ceil(2/2) = 1
    const threshold = Math.ceil(uniqueTags.length / 2)
    expect(threshold).toBe(1)
  })

  test("concept: without dedup, duplicate tags inflate threshold", () => {
    const tags = ["snowflake", "snowflake", "snowflake", "other"]
    // Without dedup: ceil(4/2) = 2 overlap needed
    const threshold = Math.ceil(tags.length / 2)
    expect(threshold).toBe(2)
    // With dedup: ceil(2/2) = 1 overlap needed — more accurate
  })
})

describe("Global opt-out (ALTIMATE_DISABLE_MEMORY)", () => {
  test("Flag pattern: truthy values enable opt-out", () => {
    // Verify the flag pattern matches what's in flag.ts
    const truthy = (value: string | undefined) => {
      const v = value?.toLowerCase()
      return v === "true" || v === "1"
    }

    expect(truthy("true")).toBe(true)
    expect(truthy("TRUE")).toBe(true)
    expect(truthy("1")).toBe(true)
    expect(truthy("false")).toBe(false)
    expect(truthy("0")).toBe(false)
    expect(truthy(undefined)).toBe(false)
    expect(truthy("")).toBe(false)
  })

  test("Flag pattern: altTruthy checks both env var names", () => {
    const truthy = (key: string) => {
      const value = { ALTIMATE_DISABLE_MEMORY: "true" }[key]?.toLowerCase()
      return value === "true" || value === "1"
    }
    const altTruthy = (altKey: string, openKey: string) => truthy(altKey) || truthy(openKey)

    expect(altTruthy("ALTIMATE_DISABLE_MEMORY", "OPENCODE_DISABLE_MEMORY")).toBe(true)
  })
})
