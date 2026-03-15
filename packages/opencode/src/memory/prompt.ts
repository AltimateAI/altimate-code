import { MemoryStore, isExpired } from "./store"
import { MEMORY_DEFAULT_INJECTION_BUDGET, type MemoryBlock } from "./types"
import { Telemetry } from "@/altimate/telemetry"

export namespace MemoryPrompt {
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

  export async function inject(budget: number = MEMORY_DEFAULT_INJECTION_BUDGET): Promise<string> {
    const blocks = await MemoryStore.listAll()
    if (blocks.length === 0) return ""

    const header = "## Altimate Memory\n\nThe following memory blocks were saved from previous sessions:\n"
    let result = header
    let used = header.length
    let injectedCount = 0
    const scopesSeen = new Set<string>()

    for (const block of blocks) {
      if (isExpired(block)) continue
      const formatted = formatBlock(block)
      const needed = formatted.length + 2
      if (used + needed > budget) break
      result += "\n" + formatted + "\n"
      used += needed
      injectedCount++
      scopesSeen.add(block.scope)
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

    return result
  }
}
