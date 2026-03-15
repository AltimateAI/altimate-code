// altimate_change - Training store wrapping MemoryStore for learned knowledge
import { MemoryStore, type MemoryBlock } from "../../memory"
import {
  TRAINING_TAG,
  TRAINING_MAX_PATTERNS_PER_KIND,
  TrainingKind,
  trainingId,
  trainingTags,
  isTrainingBlock,
  trainingKind,
  parseTrainingMeta,
  embedTrainingMeta,
  type TrainingBlockMeta,
} from "./types"

export interface TrainingEntry {
  id: string
  kind: TrainingKind
  name: string
  scope: "global" | "project"
  content: string
  meta: TrainingBlockMeta
  created: string
  updated: string
  citations?: MemoryBlock["citations"]
}

export namespace TrainingStore {
  export async function save(input: {
    kind: TrainingKind
    name: string
    scope: "global" | "project"
    content: string
    source?: string
    citations?: MemoryBlock["citations"]
  }): Promise<{ entry: TrainingEntry; duplicates: MemoryBlock[] }> {
    const id = trainingId(input.kind, input.name)
    const existing = await MemoryStore.read(input.scope, id)
    const now = new Date().toISOString()

    const prevMeta = existing ? parseTrainingMeta(existing.content) : undefined
    const meta: TrainingBlockMeta = {
      kind: input.kind,
      source: input.source,
      applied: prevMeta?.applied ?? 0,
    }

    const enriched = embedTrainingMeta(input.content, meta)

    const { duplicates } = await MemoryStore.write({
      id,
      scope: input.scope,
      tags: trainingTags(input.kind),
      created: existing?.created ?? now,
      updated: now,
      citations: input.citations,
      content: enriched,
    })

    return {
      entry: {
        id,
        kind: input.kind,
        name: input.name,
        scope: input.scope,
        content: input.content,
        meta,
        created: existing?.created ?? now,
        updated: now,
        citations: input.citations,
      },
      duplicates,
    }
  }

  export async function list(opts?: {
    kind?: TrainingKind
    scope?: "global" | "project" | "all"
  }): Promise<TrainingEntry[]> {
    const scope = opts?.scope ?? "all"
    const blocks =
      scope === "all" ? await MemoryStore.listAll() : await MemoryStore.list(scope)

    return blocks
      .filter(isTrainingBlock)
      .filter((b) => !opts?.kind || b.tags.includes(opts.kind))
      .map(toEntry)
      .filter((e): e is TrainingEntry => e !== undefined)
  }

  export async function get(
    scope: "global" | "project",
    kind: TrainingKind,
    name: string,
  ): Promise<TrainingEntry | undefined> {
    const block = await MemoryStore.read(scope, trainingId(kind, name))
    if (!block || !isTrainingBlock(block)) return undefined
    return toEntry(block)
  }

  export async function remove(
    scope: "global" | "project",
    kind: TrainingKind,
    name: string,
  ): Promise<boolean> {
    return MemoryStore.remove(scope, trainingId(kind, name))
  }

  export async function count(opts?: {
    kind?: TrainingKind
    scope?: "global" | "project" | "all"
  }): Promise<Record<TrainingKind, number>> {
    const entries = await list(opts)
    const counts: Record<string, number> = Object.fromEntries(TrainingKind.options.map((k) => [k, 0]))
    for (const entry of entries) {
      counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
    }
    return counts as Record<TrainingKind, number>
  }

  export async function incrementApplied(
    scope: "global" | "project",
    kind: TrainingKind,
    name: string,
  ): Promise<void> {
    const block = await MemoryStore.read(scope, trainingId(kind, name))
    if (!block) return
    const meta = parseTrainingMeta(block.content)
    if (!meta) return
    meta.applied++
    const now = new Date().toISOString()
    await MemoryStore.write({
      ...block,
      updated: now,
      content: embedTrainingMeta(stripTrainingMeta(block.content), meta),
    })
  }

  function toEntry(block: MemoryBlock): TrainingEntry | undefined {
    const kind = trainingKind(block)
    if (!kind) return undefined
    const meta = parseTrainingMeta(block.content) ?? {
      kind,
      applied: 0,
    }
    return {
      id: block.id,
      kind,
      name: extractName(block.id),
      scope: block.scope,
      content: stripTrainingMeta(block.content),
      meta,
      created: block.created,
      updated: block.updated,
      citations: block.citations,
    }
  }

  function extractName(id: string): string {
    // training/pattern/staging-model → staging-model
    const parts = id.split("/")
    return parts.length >= 3 ? parts.slice(2).join("/") : parts[parts.length - 1]
  }
}

function stripTrainingMeta(content: string): string {
  return content.replace(/^<!--\s*training\n[\s\S]*?-->\n*/, "").trim()
}
