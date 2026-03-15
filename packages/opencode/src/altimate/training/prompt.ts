// altimate_change - Training prompt (deprecated — delegates to unified MemoryPrompt.inject)
// Kept for backward compatibility with training tools (budgetUsage) and tests.
import { MemoryPrompt } from "../../memory/prompt"
import { TRAINING_BUDGET } from "./types"
import type { TrainingEntry } from "./store"

export namespace TrainingPrompt {
  /** Format a training entry for display. */
  export function formatEntry(entry: TrainingEntry): string {
    const meta = entry.meta.applied > 0 ? ` (applied ${entry.meta.applied}x)` : ""
    return `#### ${entry.name}${meta}\n${entry.content}`
  }

  /** @deprecated — Use MemoryPrompt.resetSession(). Kept for backward compat. */
  export function resetSession(): void {
    MemoryPrompt.resetSession()
  }

  /** @deprecated — Use MemoryPrompt.inject() with context. Kept for training tool compat. */
  export async function inject(budget: number = TRAINING_BUDGET): Promise<string> {
    return MemoryPrompt.injectTrainingOnly(budget)
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
