// altimate_change - Training prompt injection for AI Teammate learned knowledge
import { TrainingStore, type TrainingEntry } from "./store"
import { TRAINING_BUDGET, type TrainingKind } from "./types"

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
}

export namespace TrainingPrompt {
  export function formatEntry(entry: TrainingEntry): string {
    const meta = entry.meta.applied > 0 ? ` (applied ${entry.meta.applied}x)` : ""
    return `#### ${entry.name}${meta}\n${entry.content}`
  }

  export async function inject(budget: number = TRAINING_BUDGET): Promise<string> {
    const entries = await TrainingStore.list()
    if (entries.length === 0) return ""

    const grouped = new Map<TrainingKind, TrainingEntry[]>()
    for (const entry of entries) {
      const list = grouped.get(entry.kind) ?? []
      list.push(entry)
      grouped.set(entry.kind, list)
    }

    const header =
      "## Teammate Training\n\nYou have been trained on the following knowledge by your team. Apply it consistently.\n"
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

  export async function budgetUsage(budget: number = TRAINING_BUDGET): Promise<{
    used: number
    budget: number
    percent: number
  }> {
    const injected = await inject(budget)
    const used = injected.length
    return {
      used,
      budget,
      percent: budget > 0 ? Math.round((used / budget) * 100) : 0,
    }
  }
}
