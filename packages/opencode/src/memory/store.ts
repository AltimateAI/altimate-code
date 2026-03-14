// altimate_change - Altimate Memory persistent store
import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { MEMORY_MAX_BLOCK_SIZE, MEMORY_MAX_BLOCKS_PER_SCOPE, type MemoryBlock, type Citation } from "./types"

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

function globalDir(): string {
  return path.join(Global.Path.data, "memory")
}

function projectDir(): string {
  return path.join(Instance.directory, ".opencode", "memory")
}

function dirForScope(scope: "global" | "project"): string {
  return scope === "global" ? globalDir() : projectDir()
}

function blockPath(scope: "global" | "project", id: string): string {
  return path.join(dirForScope(scope), ...id.split("/").slice(0, -1), `${id.split("/").pop()}.md`)
}

function auditLogPath(scope: "global" | "project"): string {
  return path.join(dirForScope(scope), ".log")
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

function serializeBlock(block: MemoryBlock): string {
  const tags = block.tags.length > 0 ? `\ntags: ${JSON.stringify(block.tags)}` : ""
  const expires = block.expires ? `\nexpires: ${block.expires}` : ""
  const citations = block.citations && block.citations.length > 0 ? `\ncitations: ${JSON.stringify(block.citations)}` : ""
  return [
    "---",
    `id: ${block.id}`,
    `scope: ${block.scope}`,
    `created: ${block.created}`,
    `updated: ${block.updated}${tags}${expires}${citations}`,
    "---",
    "",
    block.content,
    "",
  ].join("\n")
}

export function isExpired(block: MemoryBlock): boolean {
  if (!block.expires) return false
  return new Date(block.expires) <= new Date()
}

async function appendAuditLog(scope: "global" | "project", entry: string): Promise<void> {
  const logPath = auditLogPath(scope)
  const dir = path.dirname(logPath)
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(logPath, entry + "\n", "utf-8")
  } catch {
    // Audit logging is best-effort — never fail the operation
  }
}

function auditEntry(action: string, id: string, scope: string, extra?: string): string {
  const ts = new Date().toISOString()
  const suffix = extra ? ` ${extra}` : ""
  return `[${ts}] ${action} ${scope}/${id}${suffix}`
}

export namespace MemoryStore {
  export async function read(scope: "global" | "project", id: string): Promise<MemoryBlock | undefined> {
    const filepath = blockPath(scope, id)
    let raw: string
    try {
      raw = await fs.readFile(filepath, "utf-8")
    } catch (e: any) {
      if (e.code === "ENOENT") return undefined
      throw e
    }

    const parsed = parseFrontmatter(raw)
    if (!parsed) return undefined

    const citations = (() => {
      if (!parsed.meta.citations) return undefined
      if (Array.isArray(parsed.meta.citations)) return parsed.meta.citations as Citation[]
      return undefined
    })()

    return {
      id: String(parsed.meta.id ?? id),
      scope: (parsed.meta.scope as "global" | "project") ?? scope,
      tags: Array.isArray(parsed.meta.tags) ? (parsed.meta.tags as string[]) : [],
      created: String(parsed.meta.created ?? new Date().toISOString()),
      updated: String(parsed.meta.updated ?? new Date().toISOString()),
      expires: parsed.meta.expires ? String(parsed.meta.expires) : undefined,
      citations,
      content: parsed.content,
    }
  }

  export async function list(scope: "global" | "project", opts?: { includeExpired?: boolean }): Promise<MemoryBlock[]> {
    const dir = dirForScope(scope)
    const blocks: MemoryBlock[] = []

    async function scanDir(currentDir: string, prefix: string) {
      let entries: { name: string; isDirectory: () => boolean }[]
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true })
      } catch (e: any) {
        if (e.code === "ENOENT") return
        throw e
      }

      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue
        if (entry.isDirectory()) {
          await scanDir(path.join(currentDir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name)
        } else if (entry.name.endsWith(".md")) {
          const baseName = entry.name.slice(0, -3)
          const id = prefix ? `${prefix}/${baseName}` : baseName
          const block = await read(scope, id)
          if (block) {
            if (!opts?.includeExpired && isExpired(block)) continue
            blocks.push(block)
          }
        }
      }
    }

    await scanDir(dir, "")
    blocks.sort((a, b) => b.updated.localeCompare(a.updated))
    return blocks
  }

  export async function listAll(opts?: { includeExpired?: boolean }): Promise<MemoryBlock[]> {
    const [global, project] = await Promise.all([list("global", opts), list("project", opts)])
    const all = [...project, ...global]
    all.sort((a, b) => b.updated.localeCompare(a.updated))
    return all
  }

  export async function findDuplicates(
    scope: "global" | "project",
    block: { id: string; tags: string[] },
  ): Promise<MemoryBlock[]> {
    const existing = await list(scope)
    return existing.filter((b) => {
      if (b.id === block.id) return false // same block = update, not duplicate
      if (block.tags.length === 0) return false
      const overlap = block.tags.filter((t) => b.tags.includes(t))
      return overlap.length >= Math.ceil(block.tags.length / 2)
    })
  }

  export async function write(block: MemoryBlock): Promise<{ duplicates: MemoryBlock[] }> {
    if (block.content.length > MEMORY_MAX_BLOCK_SIZE) {
      throw new Error(
        `Memory block "${block.id}" content exceeds maximum size of ${MEMORY_MAX_BLOCK_SIZE} characters (got ${block.content.length})`,
      )
    }

    const existing = await list(block.scope, { includeExpired: true })
    const isUpdate = existing.some((b) => b.id === block.id)
    if (!isUpdate && existing.length >= MEMORY_MAX_BLOCKS_PER_SCOPE) {
      throw new Error(
        `Cannot create memory block "${block.id}": scope "${block.scope}" already has ${MEMORY_MAX_BLOCKS_PER_SCOPE} blocks (maximum). Delete an existing block first.`,
      )
    }

    const duplicates = await findDuplicates(block.scope, block)

    const filepath = blockPath(block.scope, block.id)
    const dir = path.dirname(filepath)
    await fs.mkdir(dir, { recursive: true })

    const tmpPath = filepath + ".tmp"
    const serialized = serializeBlock(block)

    await fs.writeFile(tmpPath, serialized, "utf-8")
    await fs.rename(tmpPath, filepath)

    const action = isUpdate ? "UPDATE" : "CREATE"
    await appendAuditLog(block.scope, auditEntry(action, block.id, block.scope))

    return { duplicates }
  }

  export async function remove(scope: "global" | "project", id: string): Promise<boolean> {
    const filepath = blockPath(scope, id)
    try {
      await fs.unlink(filepath)
      await appendAuditLog(scope, auditEntry("DELETE", id, scope))
      return true
    } catch (e: any) {
      if (e.code === "ENOENT") return false
      throw e
    }
  }

  export async function readAuditLog(scope: "global" | "project", limit: number = 50): Promise<string[]> {
    const logPath = auditLogPath(scope)
    try {
      const raw = await fs.readFile(logPath, "utf-8")
      const lines = raw.trim().split("\n").filter(Boolean)
      return lines.slice(-limit)
    } catch (e: any) {
      if (e.code === "ENOENT") return []
      throw e
    }
  }
}
