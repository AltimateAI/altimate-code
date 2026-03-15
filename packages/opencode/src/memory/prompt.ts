// altimate_change - Unified context-aware injection for memory + training
import { Log } from "@/util/log"
import { MemoryStore, isExpired } from "./store"
import {
  MEMORY_DEFAULT_INJECTION_BUDGET,
  UNIFIED_INJECTION_BUDGET,
  AGENT_TRAINING_RELEVANCE,
  type MemoryBlock,
  type InjectionContext,
} from "./types"
import { Telemetry } from "@/altimate/telemetry"
import {
  isTrainingBlock,
  trainingKind,
  parseTrainingMeta,
  type TrainingKind,
} from "@/altimate/training/types"
import { TrainingStore } from "@/altimate/training/store"

// Training kind display headers (moved from training/prompt.ts)
const KIND_HEADERS: Record<TrainingKind, { header: string; instruction: string }> = {
  pattern: {
    header: "Learned Patterns",
    instruction: "Follow these patterns when creating similar artifacts. They were learned from the user's codebase.",
  },
  rule: {
    header: "Learned Rules",
    instruction: "Always follow these rules. They were taught by the user through corrections and explicit instruction.",
  },
  glossary: {
    header: "Domain Glossary",
    instruction: "Use these definitions when discussing business concepts. They are specific to the user's domain.",
  },
  standard: {
    header: "Team Standards",
    instruction: "Enforce these standards in code reviews and when writing new code. They were loaded from team documentation.",
  },
  context: {
    header: "Domain Context",
    instruction: "Use this background knowledge to inform your reasoning. Not directly enforceable, but critical for understanding 'why'.",
  },
  playbook: {
    header: "Playbooks",
    instruction: "Follow these step-by-step procedures when handling the described scenarios.",
  },
}

const KIND_ORDER: TrainingKind[] = ["rule", "pattern", "standard", "glossary", "context", "playbook"]

// Track which training entries have been applied this session (prevents double-counting)
const appliedThisSession = new Set<string>()

export namespace MemoryPrompt {
  /** Reset per-session applied tracking. Call at session start (step === 1). */
  export function resetSession(): void {
    appliedThisSession.clear()
  }

  /** Format a non-training memory block for display. */
  export function formatBlock(block: MemoryBlock): string {
    const tagsStr = block.tags.length > 0 ? ` [${block.tags.join(", ")}]` : ""
    const expiresStr = block.expires ? ` (expires: ${block.expires})` : ""
    let result = `### ${block.id} (${block.scope})${tagsStr}${expiresStr}\n${block.content}`

    if (block.citations && block.citations.length > 0) {
      const citationLines = block.citations.map((c) => {
        const lineStr = c.line ? `:${c.line}` : ""
        const noteStr = c.note ? ` — ${c.note}` : ""
        return `- \`${c.file}${lineStr}\`${noteStr}`
      })
      result += "\n\n**Sources:**\n" + citationLines.join("\n")
    }

    return result
  }

  /** Format a training entry for display (with applied count). */
  function formatTrainingEntry(block: MemoryBlock): string {
    const meta = parseTrainingMeta(block.content)
    const appliedStr = meta && meta.applied > 0 ? ` (applied ${meta.applied}x)` : ""
    // Strip the training metadata comment from content for display
    const content = block.content.replace(/^<!--\s*training\n[\s\S]*?-->\n*/, "").trim()
    const name = block.id.split("/").slice(2).join("/") || block.id
    return `#### ${name}${appliedStr}\n${content}`
  }

  /** Score a block for relevance to the current agent context. */
  function scoreBlock(block: MemoryBlock, ctx?: InjectionContext): number {
    let score = 0
    const agentName = ctx?.agent

    if (isTrainingBlock(block)) {
      // Exclude training if disabled
      if (ctx?.disableTraining) return -1

      // Agent-specific kind relevance
      const kind = trainingKind(block)
      if (kind && agentName) {
        const relevance = AGENT_TRAINING_RELEVANCE[agentName] ?? {}
        score += relevance[kind] ?? 2
      } else {
        score += 2
      }

      // Applied count bonus (capped at 3)
      const meta = parseTrainingMeta(block.content)
      if (meta) {
        score += Math.min(3, Math.floor(meta.applied / 3))
      }
    } else {
      // Non-training memory blocks are always relevant
      score += 5
    }

    // Agent tag match: block explicitly tagged for this agent
    if (agentName && block.tags.includes(agentName)) {
      score += 10
    }

    // Recency bonus
    const age = Date.now() - new Date(block.updated).getTime()
    if (age < 24 * 60 * 60 * 1000) score += 2
    else if (age < 7 * 24 * 60 * 60 * 1000) score += 1

    return score
  }

  /**
   * Unified context-aware injection. Combines memory blocks and training entries
   * into a single system prompt section, scored by relevance to the current agent.
   */
  export async function inject(
    budget: number = MEMORY_DEFAULT_INJECTION_BUDGET,
    ctx?: InjectionContext,
  ): Promise<string> {
    const blocks = await MemoryStore.listAll()
    if (blocks.length === 0) return ""

    // Score and filter
    const scored = blocks
      .filter((b) => !isExpired(b))
      .map((b) => ({ block: b, score: scoreBlock(b, ctx) }))
      .filter((s) => s.score >= 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return new Date(b.block.updated).getTime() - new Date(a.block.updated).getTime()
      })

    // Separate training blocks from memory blocks
    const trainingBlocks = scored.filter((s) => isTrainingBlock(s.block))
    const memoryBlocks = scored.filter((s) => !isTrainingBlock(s.block))

    const header = "## Altimate Knowledge\n\nKnowledge from previous sessions and team training. Apply it consistently.\n"
    let result = header
    let used = header.length
    let injectedCount = 0
    const injectedTraining: MemoryBlock[] = []
    const scopesSeen = new Set<string>()

    // Group training blocks by kind for structured display
    const byKind = new Map<TrainingKind, typeof trainingBlocks>()
    for (const item of trainingBlocks) {
      const kind = trainingKind(item.block)
      if (!kind) continue
      const list = byKind.get(kind) ?? []
      list.push(item)
      byKind.set(kind, list)
    }

    // Inject training blocks grouped by kind (priority order)
    for (const kind of KIND_ORDER) {
      const items = byKind.get(kind)
      if (!items || items.length === 0) continue

      const section = KIND_HEADERS[kind]
      const sectionHeader = `\n### ${section.header}\n_${section.instruction}_\n`

      // Check if section header fits
      if (used + sectionHeader.length > budget) continue
      // Check if at least one entry would fit
      const firstFormatted = formatTrainingEntry(items[0].block)
      if (used + sectionHeader.length + firstFormatted.length + 2 > budget) continue

      result += sectionHeader
      used += sectionHeader.length

      // Items are already sorted by score (high first)
      for (const item of items) {
        const formatted = formatTrainingEntry(item.block)
        const needed = formatted.length + 2
        if (used + needed > budget) break
        result += "\n" + formatted + "\n"
        used += needed
        injectedCount++
        injectedTraining.push(item.block)
        scopesSeen.add(item.block.scope)
      }
    }

    // Inject non-training memory blocks
    if (memoryBlocks.length > 0) {
      const memHeader = "\n### Memory\n"
      const firstMemFormatted = formatBlock(memoryBlocks[0].block)
      if (used + memHeader.length + firstMemFormatted.length + 2 <= budget) {
        result += memHeader
        used += memHeader.length

        for (const item of memoryBlocks) {
          const formatted = formatBlock(item.block)
          const needed = formatted.length + 2
          if (used + needed > budget) break
          result += "\n" + formatted + "\n"
          used += needed
          injectedCount++
          scopesSeen.add(item.block.scope)
        }
      }
    }

    // Fire-and-forget: increment applied count for training blocks (once per session)
    for (const block of injectedTraining) {
      if (!appliedThisSession.has(block.id)) {
        appliedThisSession.add(block.id)
        const kind = trainingKind(block)
        if (kind) {
          const name = block.id.split("/").slice(2).join("/")
          TrainingStore.incrementApplied(block.scope as "global" | "project", kind, name).catch((e) => {
            Log.create({ service: "memory.prompt" }).warn("failed to increment applied count", { id: block.id, error: String(e) })
          })
        }
      }
    }

    if (injectedCount > 0) {
      Telemetry.track({
        type: "memory_injection",
        timestamp: Date.now(),
        session_id: Telemetry.getContext().sessionId,
        block_count: injectedCount,
        total_chars: used,
        budget,
        scopes_used: [...scopesSeen],
      })
    }

    return injectedCount > 0 ? result : ""
  }

  /**
   * Inject training-only blocks (for backward compat with TrainingPrompt.budgetUsage).
   */
  export async function injectTrainingOnly(budget: number): Promise<string> {
    const blocks = await MemoryStore.listAll()
    const training = blocks.filter((b) => !isExpired(b) && isTrainingBlock(b))
    if (training.length === 0) return ""

    const header = "## Teammate Training\n\nYou have been trained on the following knowledge by your team. Apply it consistently.\n"
    let result = header
    let used = header.length
    let itemCount = 0

    const byKind = new Map<TrainingKind, MemoryBlock[]>()
    for (const block of training) {
      const kind = trainingKind(block)
      if (!kind) continue
      const list = byKind.get(kind) ?? []
      list.push(block)
      byKind.set(kind, list)
    }

    for (const kind of KIND_ORDER) {
      const items = byKind.get(kind)
      if (!items || items.length === 0) continue

      const section = KIND_HEADERS[kind]
      const sectionHeader = `\n### ${section.header}\n_${section.instruction}_\n`

      const sorted = [...items].sort((a, b) => {
        const metaA = parseTrainingMeta(a.content)
        const metaB = parseTrainingMeta(b.content)
        return (metaB?.applied ?? 0) - (metaA?.applied ?? 0)
      })

      // Check if header + at least one entry fits before adding header
      const firstFormatted = formatTrainingEntry(sorted[0])
      if (used + sectionHeader.length + firstFormatted.length + 2 > budget) continue
      result += sectionHeader
      used += sectionHeader.length

      for (const block of sorted) {
        const formatted = formatTrainingEntry(block)
        const needed = formatted.length + 2
        if (used + needed > budget) break
        result += "\n" + formatted + "\n"
        used += needed
        itemCount++
      }
    }

    return itemCount > 0 ? result : ""
  }
}
