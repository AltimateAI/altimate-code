import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

// Integration tests for the full training lifecycle
// Tests the end-to-end flow: save → list → format → inject → remove

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/
const TRAINING_TAG = "training"

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
  return ["---", `id: ${block.id}`, `scope: ${block.scope}`, `created: ${block.created}`, `updated: ${block.updated}${tags}`, "---", "", block.content, ""].join("\n")
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

// Prompt formatting
const KIND_HEADERS: Record<TrainingKind, { header: string; instruction: string }> = {
  pattern: { header: "Learned Patterns", instruction: "Follow these patterns when creating similar artifacts." },
  rule: { header: "Learned Rules", instruction: "Always follow these rules." },
  glossary: { header: "Domain Glossary", instruction: "Use these definitions when discussing business concepts." },
  standard: { header: "Team Standards", instruction: "Enforce these standards in code reviews and when writing new code." },
}

function formatEntry(entry: TrainingEntry): string {
  const meta = entry.meta.applied > 0 ? ` (applied ${entry.meta.applied}x)` : ""
  return `#### ${entry.name}${meta}\n${entry.content}`
}

function injectTraining(entries: TrainingEntry[], budget: number = 6000): string {
  if (entries.length === 0) return ""
  const grouped = new Map<TrainingKind, TrainingEntry[]>()
  for (const entry of entries) {
    const list = grouped.get(entry.kind) ?? []
    list.push(entry)
    grouped.set(entry.kind, list)
  }
  const header = "## Teammate Training\n\nYou have been trained on the following knowledge by your team. Apply it consistently.\n"
  let result = header
  let used = header.length
  for (const kind of ["rule", "pattern", "standard", "glossary"] as TrainingKind[]) {
    const items = grouped.get(kind)
    if (!items || items.length === 0) continue
    const section = KIND_HEADERS[kind]
    const sectionHeader = `\n### ${section.header}\n_${section.instruction}_\n`
    if (used + sectionHeader.length > budget) break
    result += sectionHeader
    used += sectionHeader.length
    for (const entry of items) {
      const formatted = formatEntry(entry)
      const needed = formatted.length + 2
      if (used + needed > budget) break
      result += "\n" + formatted + "\n"
      used += needed
    }
  }
  return result
}

// Lightweight store for integration testing
function createStore(baseDir: string) {
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
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue
        if (e.isDirectory()) await scan(path.join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name)
        else if (e.name.endsWith(".md")) {
          const id = prefix ? `${prefix}/${e.name.slice(0, -3)}` : e.name.slice(0, -3)
          const block = await readBlock(id)
          if (block) blocks.push(block)
        }
      }
    }
    await scan(baseDir, "")
    return blocks.sort((a, b) => b.updated.localeCompare(a.updated))
  }
  return {
    async save(input: { kind: TrainingKind; name: string; content: string; source?: string }) {
      const id = trainingId(input.kind, input.name)
      const existing = await readBlock(id)
      const now = new Date().toISOString()
      const prevMeta = existing ? parseTrainingMeta(existing.content) : undefined
      const meta: TrainingBlockMeta = { kind: input.kind, source: input.source, applied: prevMeta?.applied ?? 0, accepted: prevMeta?.accepted ?? 0, rejected: prevMeta?.rejected ?? 0 }
      await writeBlock({ id, scope: "project", tags: trainingTags(input.kind), created: existing?.created ?? now, updated: now, content: embedTrainingMeta(input.content, meta) })
      return { id, kind: input.kind, name: input.name, scope: "project" as const, content: input.content, meta, created: existing?.created ?? now, updated: now }
    },
    async list(opts?: { kind?: TrainingKind }): Promise<TrainingEntry[]> {
      return (await listBlocks())
        .filter((b) => b.tags.includes(TRAINING_TAG))
        .filter((b) => !opts?.kind || b.tags.includes(opts.kind))
        .map((b) => {
          const kind = b.tags.find((t) => ["pattern", "rule", "glossary", "standard"].includes(t)) as TrainingKind | undefined
          if (!kind) return undefined
          const meta = parseTrainingMeta(b.content) ?? { kind, applied: 0, accepted: 0, rejected: 0 }
          const parts = b.id.split("/")
          return { id: b.id, kind, name: parts.slice(2).join("/"), scope: b.scope, content: stripTrainingMeta(b.content), meta, created: b.created, updated: b.updated }
        })
        .filter((e): e is TrainingEntry => e !== undefined)
    },
    async remove(kind: TrainingKind, name: string): Promise<boolean> {
      try { await fs.unlink(blockPath(trainingId(kind, name))); return true } catch { return false }
    },
  }
}

let tmpDir: string
let store: ReturnType<typeof createStore>

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "training-integ-"))
  store = createStore(tmpDir)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe("Full lifecycle: save → list → format → inject", () => {
  test("saved patterns appear in injected prompt", async () => {
    await store.save({
      kind: "pattern",
      name: "staging-model",
      content: "- Use CTE for renaming columns\n- Cast types explicitly\n- Order: keys, dims, measures, timestamps",
      source: "models/staging/stg_orders.sql",
    })
    await store.save({
      kind: "rule",
      name: "no-float",
      content: "Use NUMERIC(18,2) instead of FLOAT for financial columns (*_amount, *_price, *_cost)",
      source: "user correction",
    })
    await store.save({
      kind: "glossary",
      name: "arr",
      content: "ARR (Annual Recurring Revenue): The annualized value of recurring subscription revenue",
    })

    const entries = await store.list()
    expect(entries).toHaveLength(3)

    const injected = injectTraining(entries)
    expect(injected).toContain("## Teammate Training")
    expect(injected).toContain("### Learned Rules")
    expect(injected).toContain("NUMERIC(18,2)")
    expect(injected).toContain("### Learned Patterns")
    expect(injected).toContain("CTE for renaming")
    expect(injected).toContain("### Domain Glossary")
    expect(injected).toContain("Annual Recurring Revenue")
  })

  test("removed entries disappear from injection", async () => {
    await store.save({ kind: "rule", name: "temp-rule", content: "Temporary rule" })
    let entries = await store.list()
    expect(entries).toHaveLength(1)

    await store.remove("rule", "temp-rule")
    entries = await store.list()
    expect(entries).toHaveLength(0)

    const injected = injectTraining(entries)
    expect(injected).toBe("")
  })

  test("updated entries show latest content", async () => {
    await store.save({ kind: "rule", name: "evolving", content: "Version 1" })
    await store.save({ kind: "rule", name: "evolving", content: "Version 2 — improved" })

    const entries = await store.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toBe("Version 2 — improved")

    const injected = injectTraining(entries)
    expect(injected).toContain("Version 2 — improved")
    expect(injected).not.toContain("Version 1")
  })
})

describe("Training coexists with regular memory", () => {
  test("training blocks use training/ prefix in file system", async () => {
    await store.save({ kind: "pattern", name: "test", content: "Test" })

    const filepath = path.join(tmpDir, "training", "pattern", "test.md")
    const exists = await fs.stat(filepath).then(() => true).catch(() => false)
    expect(exists).toBe(true)
  })

  test("non-training memory blocks are not listed as training", async () => {
    // Write a regular memory block (not training)
    const regularBlock: MemoryBlock = {
      id: "warehouse-config",
      scope: "project",
      tags: ["warehouse"],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      content: "Warehouse: ANALYTICS_WH",
    }
    const filepath = path.join(tmpDir, "warehouse-config.md")
    await fs.writeFile(filepath, serializeBlock(regularBlock), "utf-8")

    // Write a training block
    await store.save({ kind: "rule", name: "test", content: "Rule" })

    // Only training entries should be listed
    const entries = await store.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe("rule")
  })
})

describe("Multiple kinds interaction", () => {
  test("all four kinds coexist independently", async () => {
    await store.save({ kind: "pattern", name: "staging", content: "Staging pattern" })
    await store.save({ kind: "rule", name: "naming", content: "Naming rule" })
    await store.save({ kind: "glossary", name: "mrr", content: "Monthly Recurring Revenue" })
    await store.save({ kind: "standard", name: "review", content: "Review standard" })

    const all = await store.list()
    expect(all).toHaveLength(4)

    const patterns = await store.list({ kind: "pattern" })
    expect(patterns).toHaveLength(1)
    expect(patterns[0].name).toBe("staging")

    const rules = await store.list({ kind: "rule" })
    expect(rules).toHaveLength(1)
    expect(rules[0].name).toBe("naming")
  })

  test("removing one kind doesn't affect others", async () => {
    await store.save({ kind: "pattern", name: "p1", content: "P" })
    await store.save({ kind: "rule", name: "r1", content: "R" })

    await store.remove("pattern", "p1")

    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0].kind).toBe("rule")
  })
})

describe("Prompt injection ordering and budget", () => {
  test("rules appear before patterns in injection", async () => {
    await store.save({ kind: "pattern", name: "p1", content: "Pattern content" })
    await store.save({ kind: "rule", name: "r1", content: "Rule content" })

    const entries = await store.list()
    const injected = injectTraining(entries)

    const rulePos = injected.indexOf("### Learned Rules")
    const patternPos = injected.indexOf("### Learned Patterns")
    expect(rulePos).toBeLessThan(patternPos)
  })

  test("large training sets are truncated by budget", async () => {
    // Create 30 rules with substantial content
    for (let i = 0; i < 30; i++) {
      await store.save({
        kind: "rule",
        name: `rule-${String(i).padStart(2, "0")}`,
        content: `This is rule ${i}: ${"x".repeat(150)}`,
      })
    }

    const entries = await store.list()
    const injected = injectTraining(entries, 2000) // Small budget
    expect(injected.length).toBeLessThan(2500) // Some slack
    expect(injected).toContain("## Teammate Training") // Header always present
  })

  test("empty training produces empty injection", async () => {
    const entries = await store.list()
    const injected = injectTraining(entries)
    expect(injected).toBe("")
  })
})

describe("Applied count tracking", () => {
  test("new entries start with applied=0", async () => {
    await store.save({ kind: "rule", name: "fresh", content: "New rule" })
    const entry = (await store.list())[0]
    expect(entry.meta.applied).toBe(0)
  })

  test("applied count survives updates", async () => {
    await store.save({ kind: "rule", name: "tracked", content: "V1" })

    // Manually update the applied count in the file
    const filepath = path.join(tmpDir, "training", "rule", "tracked.md")
    let raw = await fs.readFile(filepath, "utf-8")
    raw = raw.replace("applied: 0", "applied: 10")
    await fs.writeFile(filepath, raw, "utf-8")

    // Update content — applied should be preserved
    await store.save({ kind: "rule", name: "tracked", content: "V2" })
    const entry = (await store.list({ kind: "rule" }))[0]
    expect(entry.content).toBe("V2")
    expect(entry.meta.applied).toBe(10)
  })

  test("highly-applied entries show count in formatted output", async () => {
    await store.save({ kind: "rule", name: "popular", content: "Popular rule" })
    const filepath = path.join(tmpDir, "training", "rule", "popular.md")
    let raw = await fs.readFile(filepath, "utf-8")
    raw = raw.replace("applied: 0", "applied: 15")
    await fs.writeFile(filepath, raw, "utf-8")

    const entries = await store.list()
    const formatted = formatEntry(entries[0])
    expect(formatted).toContain("(applied 15x)")
  })
})

describe("Source tracking", () => {
  test("source from /teach is preserved", async () => {
    await store.save({
      kind: "pattern",
      name: "staging",
      content: "Pattern details",
      source: "models/staging/stg_orders.sql",
    })
    const entry = (await store.list())[0]
    expect(entry.meta.source).toBe("models/staging/stg_orders.sql")
  })

  test("source from user correction is preserved", async () => {
    await store.save({
      kind: "rule",
      name: "no-float",
      content: "Use NUMERIC",
      source: "user correction",
    })
    const entry = (await store.list())[0]
    expect(entry.meta.source).toBe("user correction")
  })

  test("source from /train URL is preserved", async () => {
    await store.save({
      kind: "standard",
      name: "style-guide",
      content: "SQL style rules",
      source: "https://wiki.company.com/sql-style",
    })
    const entry = (await store.list())[0]
    expect(entry.meta.source).toBe("https://wiki.company.com/sql-style")
  })
})

describe("Git-ready file format", () => {
  test("files are valid markdown readable by humans", async () => {
    await store.save({
      kind: "pattern",
      name: "staging-model",
      content: "## Staging Model Pattern\n\n- Use source() macro\n- Cast types in first CTE\n- Order: keys → dims → measures → timestamps",
      source: "stg_orders.sql",
    })

    const raw = await fs.readFile(
      path.join(tmpDir, "training", "pattern", "staging-model.md"),
      "utf-8",
    )

    // Should be valid markdown with frontmatter
    expect(raw).toMatch(/^---\n/)
    expect(raw).toContain("## Staging Model Pattern")
    expect(raw).toContain("- Use source() macro")
    // Human-readable metadata
    expect(raw).toContain("kind: pattern")
    expect(raw).toContain("source: stg_orders.sql")
  })
})
