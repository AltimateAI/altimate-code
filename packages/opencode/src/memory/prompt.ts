import { MemoryStore } from "./store"
import { MEMORY_DEFAULT_INJECTION_BUDGET } from "./types"

export namespace MemoryPrompt {
  export function formatBlock(block: { id: string; scope: string; tags: string[]; content: string }): string {
    const tagsStr = block.tags.length > 0 ? ` [${block.tags.join(", ")}]` : ""
    return `### ${block.id} (${block.scope})${tagsStr}\n${block.content}`
  }

  export async function inject(budget: number = MEMORY_DEFAULT_INJECTION_BUDGET): Promise<string> {
    const blocks = await MemoryStore.listAll()
    if (blocks.length === 0) return ""

    const header = "## Agent Memory\n\nThe following memory blocks were saved from previous sessions:\n"
    let result = header
    let used = header.length

    for (const block of blocks) {
      const formatted = formatBlock(block)
      const needed = formatted.length + 2 // +2 for double newline separator
      if (used + needed > budget) break
      result += "\n" + formatted + "\n"
      used += needed
    }

    return result
  }
}
