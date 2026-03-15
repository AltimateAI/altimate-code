import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

// Standalone test harness that mirrors TrainingStore logic
// Tests the training layer on top of memory without Instance context.

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/
const TRAINING_TAG = "training"
const TRAINING_MAX_PATTERNS_PER_KIND = 20

type TrainingKind = "pattern" | "rule" | "glossary" | "standard"

interface TrainingBlockMeta {
  kind: TrainingKind
  source?: string
  applied: number
  accepted: number
  rejected: number
}

interface MemoryBlock {
  id: string
  scope: "global" | "project"
  tags: string[]
  created: string
  updated: string
  content: string
  citations?: { file: string; line?: number; note?: string }[]
}

interface TrainingEntry {
  id: string
  kind: TrainingKind
  name: string
  scope: "global" | "project"
  content: string
  meta: TrainingBlockMeta
  created: string
  updated: string
}

function trainingId(kind: TrainingKind, name: string): string {
  return `training/${kind}/${name}`
}

function trainingTags(kind: TrainingKind): string[] {
  return [TRAINING_TAG, kind]
}

function embedTrainingMeta(content: string, meta: TrainingBlockMeta): string {
  const header = [
    "<!-- training",
    `kind: ${meta.kind}`,
    ...(meta.source ? [`source: ${meta.source}`] : []),
    `applied: ${meta.applied}`,
    `accepted: ${meta.accepted}`,
    `rejected: ${meta.rejected}`,
    "-->",
  ].join("\n")
  const stripped = content.replace(/^<!--\s*training\n[\s\S]*?-->\n*/m, "")
  return header + "\n" + stripped
}

function parseTrainingMeta(content: string): TrainingBlockMeta | undefined {
  const match = content.match(/^<!--\s*training\n([\s\S]*?)\n-->/m)
  if (!match) return undefined
  const meta: Record<string, unknown> = {}
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value: unknown = line.slice(idx + 1).trim()
    if (value === "") continue
    if (/^\d+$/.test(value as string)) value = parseInt(value as string, 10)
    meta[key] = value
  }
  if (!meta.kind) return undefined
  return {
    kind: meta.kind as TrainingKind,
    source: meta.source as string | undefined,
    applied: (meta.applied as number) ?? 0,
    accepted: (meta.accepted as number) ?? 0,
    rejected: (meta.rejected as number) ?? 0,
  }
}

function stripTrainingMeta(content: string): string {
  return content.replace(/^<!--\s*training\n[\s\S]*?-->\n*/m, "").trim()
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
      try { value = JSON.parse(value) } catch {}
    }
    meta[key] = value
  }
  return { meta, content: match[2].trim() }
}

// Standalone training store for testing
function createTestTrainingStore(baseDir: string) {
  function blockPath(id: string): string {
    const parts = id.split("/")
    return path.join(baseDir, ...parts.slice(0, -1), `${parts[parts.length - 1]}.md`)
  }

  async function readBlock(id: string): Promise<MemoryBlock | undefined> {
    try {
      const raw = await fs.readFile(blockPath(id), "utf-8")
      const parsed = parseFrontmatter(raw)
      if (!parsed) return undefined
      return {
        id: String(parsed.meta.id ?? id),
        scope: (parsed.meta.scope as "global" | "project") ?? "project",
        tags: Array.isArray(parsed.meta.tags) ? parsed.meta.tags as string[] : [],
        created: String(parsed.meta.created ?? new Date().toISOString()),
        updated: String(parsed.meta.updated ?? new Date().toISOString()),
        content: parsed.content,
      }
    } catch (e: any) {
      if (e.code === "ENOENT") return undefined
      throw e
    }
  }

  async function writeBlock(block: MemoryBlock): Promise<void> {
    const filepath = blockPath(block.id)
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    await fs.writeFile(filepath, serializeBlock(block), "utf-8")
  }

  async function listBlocks(): Promise<MemoryBlock[]> {
    const blocks: MemoryBlock[] = []
    async function scan(dir: string, prefix: string) {
      let entries: { name: string; isDirectory: () => boolean }[]
      try { entries = await fs.readdir(dir, { withFileTypes: true }) }
      catch { return }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue
        if (entry.isDirectory()) {
          await scan(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name)
        } else if (entry.name.endsWith(".md")) {
          const id = prefix ? `${prefix}/${entry.name.slice(0, -3)}` : entry.name.slice(0, -3)
          const block = await readBlock(id)
          if (block) blocks.push(block)
        }
      }
    }
    await scan(baseDir, "")
    blocks.sort((a, b) => b.updated.localeCompare(a.updated))
    return blocks
  }

  return {
    async save(input: {
      kind: TrainingKind
      name: string
      content: string
      source?: string
    }): Promise<TrainingEntry> {
      const id = trainingId(input.kind, input.name)
      const existing = await readBlock(id)
      const now = new Date().toISOString()

      const prevMeta = existing ? parseTrainingMeta(existing.content) : undefined
      const meta: TrainingBlockMeta = {
        kind: input.kind,
        source: input.source,
        applied: prevMeta?.applied ?? 0,
        accepted: prevMeta?.accepted ?? 0,
        rejected: prevMeta?.rejected ?? 0,
      }

      const enriched = embedTrainingMeta(input.content, meta)

      await writeBlock({
        id,
        scope: "project",
        tags: trainingTags(input.kind),
        created: existing?.created ?? now,
        updated: now,
        content: enriched,
      })

      return {
        id,
        kind: input.kind,
        name: input.name,
        scope: "project",
        content: input.content,
        meta,
        created: existing?.created ?? now,
        updated: now,
      }
    },

    async list(opts?: { kind?: TrainingKind }): Promise<TrainingEntry[]> {
      const blocks = await listBlocks()
      return blocks
        .filter((b) => b.tags.includes(TRAINING_TAG))
        .filter((b) => !opts?.kind || b.tags.includes(opts.kind))
        .map((b) => {
          const kind = b.tags.find((t) => ["pattern", "rule", "glossary", "standard"].includes(t)) as TrainingKind | undefined
          if (!kind) return undefined
          const meta = parseTrainingMeta(b.content) ?? { kind, applied: 0, accepted: 0, rejected: 0 }
          const parts = b.id.split("/")
          return {
            id: b.id,
            kind,
            name: parts.length >= 3 ? parts.slice(2).join("/") : parts[parts.length - 1],
            scope: b.scope,
            content: stripTrainingMeta(b.content),
            meta,
            created: b.created,
            updated: b.updated,
          } as TrainingEntry
        })
        .filter((e): e is TrainingEntry => e !== undefined)
    },

    async get(kind: TrainingKind, name: string): Promise<TrainingEntry | undefined> {
      const entries = await this.list({ kind })
      return entries.find((e) => e.name === name)
    },

    async remove(kind: TrainingKind, name: string): Promise<boolean> {
      const filepath = blockPath(trainingId(kind, name))
      try {
        await fs.unlink(filepath)
        return true
      } catch (e: any) {
        if (e.code === "ENOENT") return false
        throw e
      }
    },

    async count(): Promise<Record<TrainingKind, number>> {
      const entries = await this.list()
      const counts = { pattern: 0, rule: 0, glossary: 0, standard: 0 }
      for (const e of entries) counts[e.kind]++
      return counts
    },
  }
}

let tmpDir: string
let store: ReturnType<typeof createTestTrainingStore>

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "training-test-"))
  store = createTestTrainingStore(tmpDir)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("TrainingStore", () => {
  describe("save and get", () => {
    test("saves and retrieves a pattern", async () => {
      const entry = await store.save({
        kind: "pattern",
        name: "staging-model",
        content: "- Use CTE for renaming\n- Cast types explicitly",
        source: "models/staging/stg_orders.sql",
      })
      expect(entry.kind).toBe("pattern")
      expect(entry.name).toBe("staging-model")
      expect(entry.id).toBe("training/pattern/staging-model")

      const retrieved = await store.get("pattern", "staging-model")
      expect(retrieved).toBeDefined()
      expect(retrieved!.content).toBe("- Use CTE for renaming\n- Cast types explicitly")
      expect(retrieved!.meta.source).toBe("models/staging/stg_orders.sql")
    })

    test("saves and retrieves a rule", async () => {
      await store.save({
        kind: "rule",
        name: "no-float",
        content: "Use NUMERIC(18,2) instead of FLOAT for financial columns",
        source: "user correction",
      })
      const entry = await store.get("rule", "no-float")
      expect(entry).toBeDefined()
      expect(entry!.kind).toBe("rule")
      expect(entry!.meta.source).toBe("user correction")
    })

    test("saves glossary term", async () => {
      await store.save({
        kind: "glossary",
        name: "arr",
        content: "ARR (Annual Recurring Revenue): The annualized value of recurring subscription revenue.",
      })
      const entry = await store.get("glossary", "arr")
      expect(entry).toBeDefined()
      expect(entry!.content).toContain("Annual Recurring Revenue")
    })

    test("saves standard", async () => {
      await store.save({
        kind: "standard",
        name: "sql-style",
        content: "1. Always use uppercase SQL keywords\n2. Indent with 2 spaces\n3. One column per line in SELECT",
      })
      const entry = await store.get("standard", "sql-style")
      expect(entry).toBeDefined()
      expect(entry!.content).toContain("uppercase SQL keywords")
    })

    test("updates existing entry preserving applied count", async () => {
      // Save initial
      await store.save({ kind: "rule", name: "test-rule", content: "Version 1" })

      // Manually bump applied count in the file
      const id = trainingId("rule", "test-rule")
      const filepath = path.join(tmpDir, ...id.split("/").slice(0, -1), `${id.split("/").pop()}.md`)
      let raw = await fs.readFile(filepath, "utf-8")
      raw = raw.replace("applied: 0", "applied: 5")
      await fs.writeFile(filepath, raw, "utf-8")

      // Update content — applied count should be preserved
      await store.save({ kind: "rule", name: "test-rule", content: "Version 2" })
      const entry = await store.get("rule", "test-rule")
      expect(entry!.content).toBe("Version 2")
      expect(entry!.meta.applied).toBe(5)
    })

    test("returns undefined for nonexistent entry", async () => {
      const entry = await store.get("pattern", "nonexistent")
      expect(entry).toBeUndefined()
    })
  })

  describe("list", () => {
    test("lists all training entries", async () => {
      await store.save({ kind: "pattern", name: "p1", content: "Pattern 1" })
      await store.save({ kind: "rule", name: "r1", content: "Rule 1" })
      await store.save({ kind: "glossary", name: "g1", content: "Glossary 1" })

      const entries = await store.list()
      expect(entries).toHaveLength(3)
    })

    test("filters by kind", async () => {
      await store.save({ kind: "pattern", name: "p1", content: "Pattern 1" })
      await store.save({ kind: "rule", name: "r1", content: "Rule 1" })
      await store.save({ kind: "rule", name: "r2", content: "Rule 2" })

      const rules = await store.list({ kind: "rule" })
      expect(rules).toHaveLength(2)
      expect(rules.every((e) => e.kind === "rule")).toBe(true)
    })

    test("returns empty for no entries", async () => {
      const entries = await store.list()
      expect(entries).toEqual([])
    })

    test("returns empty for nonexistent kind filter", async () => {
      await store.save({ kind: "pattern", name: "p1", content: "Pattern" })
      const glossary = await store.list({ kind: "glossary" })
      expect(glossary).toEqual([])
    })

    test("entries sorted by updated desc", async () => {
      await store.save({ kind: "pattern", name: "old", content: "Old" })
      // Small delay so timestamps differ
      await new Promise((r) => setTimeout(r, 10))
      await store.save({ kind: "pattern", name: "new", content: "New" })

      const entries = await store.list()
      expect(entries[0].name).toBe("new")
      expect(entries[1].name).toBe("old")
    })
  })

  describe("remove", () => {
    test("removes an existing entry", async () => {
      await store.save({ kind: "rule", name: "to-delete", content: "Delete me" })
      const removed = await store.remove("rule", "to-delete")
      expect(removed).toBe(true)
      const entry = await store.get("rule", "to-delete")
      expect(entry).toBeUndefined()
    })

    test("returns false for nonexistent entry", async () => {
      const removed = await store.remove("rule", "nonexistent")
      expect(removed).toBe(false)
    })
  })

  describe("count", () => {
    test("counts entries by kind", async () => {
      await store.save({ kind: "pattern", name: "p1", content: "P1" })
      await store.save({ kind: "pattern", name: "p2", content: "P2" })
      await store.save({ kind: "rule", name: "r1", content: "R1" })
      await store.save({ kind: "glossary", name: "g1", content: "G1" })

      const counts = await store.count()
      expect(counts.pattern).toBe(2)
      expect(counts.rule).toBe(1)
      expect(counts.glossary).toBe(1)
      expect(counts.standard).toBe(0)
    })

    test("returns all zeros for empty store", async () => {
      const counts = await store.count()
      expect(counts).toEqual({ pattern: 0, rule: 0, glossary: 0, standard: 0 })
    })
  })

  describe("file structure", () => {
    test("creates hierarchical directory structure", async () => {
      await store.save({ kind: "pattern", name: "staging-model", content: "Pattern" })
      const exists = await fs.stat(path.join(tmpDir, "training", "pattern", "staging-model.md"))
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)
    })

    test("files contain frontmatter and embedded meta", async () => {
      await store.save({
        kind: "rule",
        name: "no-float",
        content: "Use NUMERIC(18,2)",
        source: "user correction",
      })
      const raw = await fs.readFile(
        path.join(tmpDir, "training", "rule", "no-float.md"),
        "utf-8",
      )
      // Should have YAML frontmatter
      expect(raw).toMatch(/^---\n/)
      expect(raw).toContain("id: training/rule/no-float")
      expect(raw).toContain("tags: [")
      expect(raw).toContain('"training"')
      expect(raw).toContain('"rule"')
      // Should have embedded training meta
      expect(raw).toContain("<!-- training")
      expect(raw).toContain("kind: rule")
      expect(raw).toContain("source: user correction")
      expect(raw).toContain("Use NUMERIC(18,2)")
    })
  })

  describe("content stripping", () => {
    test("strips meta block from content on read", async () => {
      await store.save({ kind: "pattern", name: "test", content: "Clean content here" })
      const entry = await store.get("pattern", "test")
      expect(entry!.content).toBe("Clean content here")
      expect(entry!.content).not.toContain("<!-- training")
    })

    test("handles content with HTML comments", async () => {
      const content = "Rule: no floats\n<!-- this is a regular comment -->\nMore content"
      await store.save({ kind: "rule", name: "test", content })
      const entry = await store.get("rule", "test")
      expect(entry!.content).toContain("<!-- this is a regular comment -->")
    })
  })
})
