import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { MEMORY_MAX_BLOCK_SIZE, MEMORY_MAX_BLOCKS_PER_SCOPE, type MemoryBlock } from "./types"

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
  return path.join(dirForScope(scope), `${id}.md`)
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

    return {
      id: String(parsed.meta.id ?? id),
      scope: (parsed.meta.scope as "global" | "project") ?? scope,
      tags: Array.isArray(parsed.meta.tags) ? (parsed.meta.tags as string[]) : [],
      created: String(parsed.meta.created ?? new Date().toISOString()),
      updated: String(parsed.meta.updated ?? new Date().toISOString()),
      content: parsed.content,
    }
  }

  export async function list(scope: "global" | "project"): Promise<MemoryBlock[]> {
    const dir = dirForScope(scope)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch (e: any) {
      if (e.code === "ENOENT") return []
      throw e
    }

    const blocks: MemoryBlock[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      const id = entry.slice(0, -3)
      const block = await read(scope, id)
      if (block) blocks.push(block)
    }

    blocks.sort((a, b) => b.updated.localeCompare(a.updated))
    return blocks
  }

  export async function listAll(): Promise<MemoryBlock[]> {
    const [global, project] = await Promise.all([list("global"), list("project")])
    const all = [...project, ...global]
    all.sort((a, b) => b.updated.localeCompare(a.updated))
    return all
  }

  export async function write(block: MemoryBlock): Promise<void> {
    if (block.content.length > MEMORY_MAX_BLOCK_SIZE) {
      throw new Error(
        `Memory block "${block.id}" content exceeds maximum size of ${MEMORY_MAX_BLOCK_SIZE} characters (got ${block.content.length})`,
      )
    }

    const existing = await list(block.scope)
    const isUpdate = existing.some((b) => b.id === block.id)
    if (!isUpdate && existing.length >= MEMORY_MAX_BLOCKS_PER_SCOPE) {
      throw new Error(
        `Cannot create memory block "${block.id}": scope "${block.scope}" already has ${MEMORY_MAX_BLOCKS_PER_SCOPE} blocks (maximum). Delete an existing block first.`,
      )
    }

    const dir = dirForScope(block.scope)
    await fs.mkdir(dir, { recursive: true })

    const filepath = blockPath(block.scope, block.id)
    const tmpPath = filepath + ".tmp"
    const serialized = serializeBlock(block)

    await fs.writeFile(tmpPath, serialized, "utf-8")
    await fs.rename(tmpPath, filepath)
  }

  export async function remove(scope: "global" | "project", id: string): Promise<boolean> {
    const filepath = blockPath(scope, id)
    try {
      await fs.unlink(filepath)
      return true
    } catch (e: any) {
      if (e.code === "ENOENT") return false
      throw e
    }
  }
}
