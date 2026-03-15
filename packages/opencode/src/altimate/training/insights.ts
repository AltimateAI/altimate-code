// altimate_change - Training insights: self-improvement recommendations
// Inspired by OpenClaw's crystallization pattern — surfaces actionable
// recommendations based on training usage patterns.
import { TrainingStore, type TrainingEntry } from "./store"
import { TRAINING_MAX_PATTERNS_PER_KIND, type TrainingKind } from "./types"

export interface TrainingInsight {
  type: "stale" | "high-value" | "near-limit" | "consolidation"
  severity: "info" | "warning"
  message: string
  entries?: string[]
}

export namespace TrainingInsights {
  /**
   * Analyze training entries and return actionable insights.
   * Lightweight — reads from disk only, no LLM calls.
   */
  export async function analyze(): Promise<TrainingInsight[]> {
    const entries = await TrainingStore.list()
    if (entries.length === 0) return []

    const insights: TrainingInsight[] = []

    // 1. Stale entries: saved but never applied after being injected multiple sessions
    const stale = entries.filter((e) => e.meta.applied === 0 && isOlderThanDays(e.updated, 7))
    if (stale.length > 0) {
      insights.push({
        type: "stale",
        severity: "info",
        message: `${stale.length} training entry/entries saved 7+ days ago but never applied. Consider reviewing or removing.`,
        entries: stale.map((e) => `${e.kind}/${e.name}`),
      })
    }

    // 2. High-value entries: frequently applied, worth highlighting
    const highValue = entries.filter((e) => e.meta.applied >= 5).sort((a, b) => b.meta.applied - a.meta.applied)
    if (highValue.length > 0) {
      insights.push({
        type: "high-value",
        severity: "info",
        message: `${highValue.length} high-value entry/entries (applied 5+ times). These are your most impactful training.`,
        entries: highValue.slice(0, 5).map((e) => `${e.kind}/${e.name} (${e.meta.applied}x)`),
      })
    }

    // 3. Near-limit warnings per kind
    const counts = await TrainingStore.count()
    for (const [kind, count] of Object.entries(counts)) {
      if (count >= TRAINING_MAX_PATTERNS_PER_KIND - 2 && count < TRAINING_MAX_PATTERNS_PER_KIND) {
        insights.push({
          type: "near-limit",
          severity: "warning",
          message: `${kind} entries near limit: ${count}/${TRAINING_MAX_PATTERNS_PER_KIND}. Consider consolidating before adding more.`,
        })
      }
    }

    // 4. Consolidation opportunities: multiple entries of same kind with similar names
    const byKind = new Map<TrainingKind, TrainingEntry[]>()
    for (const e of entries) {
      const list = byKind.get(e.kind) ?? []
      list.push(e)
      byKind.set(e.kind, list)
    }
    for (const [kind, items] of byKind) {
      if (items.length < 2) continue
      // Find entries whose names share a common prefix (3+ chars)
      const groups = findRelatedEntries(items)
      for (const group of groups) {
        if (group.length >= 3) {
          insights.push({
            type: "consolidation",
            severity: "info",
            message: `${group.length} related ${kind} entries could potentially be consolidated into one.`,
            entries: group.map((e) => e.name),
          })
        }
      }
    }

    return insights
  }

  /**
   * Format insights for display in training_list output.
   */
  export function format(insights: TrainingInsight[]): string {
    if (insights.length === 0) return ""
    const lines = ["\n### Insights"]
    for (const insight of insights) {
      const icon = insight.severity === "warning" ? "!" : "-"
      lines.push(`${icon} ${insight.message}`)
      if (insight.entries && insight.entries.length > 0) {
        for (const e of insight.entries.slice(0, 5)) {
          lines.push(`  - \`${e}\``)
        }
        if (insight.entries.length > 5) {
          lines.push(`  - ...and ${insight.entries.length - 5} more`)
        }
      }
    }
    return lines.join("\n")
  }
}

function isOlderThanDays(dateStr: string, days: number): boolean {
  const created = new Date(dateStr)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  return created < cutoff
}

function findRelatedEntries(entries: TrainingEntry[]): TrainingEntry[][] {
  // Group entries that share a common prefix of 3+ characters
  const groups: TrainingEntry[][] = []
  const used = new Set<string>()

  for (let i = 0; i < entries.length; i++) {
    if (used.has(entries[i].name)) continue
    const group = [entries[i]]
    const prefix = entries[i].name.split("-")[0]
    if (prefix.length < 3) continue

    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(entries[j].name)) continue
      if (entries[j].name.startsWith(prefix)) {
        group.push(entries[j])
        used.add(entries[j].name)
      }
    }
    if (group.length >= 2) {
      used.add(entries[i].name)
      groups.push(group)
    }
  }
  return groups
}
